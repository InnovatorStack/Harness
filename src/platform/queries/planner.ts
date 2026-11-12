import { spendContext } from "../../core/context.js";
import type { ExecutionContext } from "../../core/types.js";
import { Item } from "../../items/item.js";
import type { ItemNode } from "../../items/item.js";
import { AmlLogicalOperator } from "../../items/logical.js";
import type { AmlLogicalGroup, AmlPropertyCondition } from "../../items/logical.js";
import { PredicateParser } from "../../queries/parser.js";
import { comparison, setPredicate, validatePredicate } from "../../queries/predicates.js";
import {
    Comparison,
    conjunction,
    queryDepthMax,
    queryNodesMax,
    queryTextMax,
} from "../../queries/types.js";
import type { Predicate } from "../../queries/types.js";
import type { HarnessStorage, ItemTypeDefinition } from "../../storage/types.js";
import { PlatformError, requireSuccess } from "../errors.js";
import { propertyPredicate } from "./conditions.js";
import { resolveField, selectorType } from "./fields.js";

export type ApplyQueryItem = (item: Item, context: ExecutionContext) => Promise<Item>;

export async function requestPredicate(
    storage: HarnessStorage,
    definition: ItemTypeDefinition,
    request: ItemNode,
    context: ExecutionContext,
    apply: ApplyQueryItem,
): Promise<Predicate> {
    const terms: Predicate[] = [];
    const field = (names: readonly string[]) => resolveField(storage, definition, names);

    if (request.attributes.where) {
        try {
            terms.push(new PredicateParser(request.attributes.where, field).parse());
        } catch (error) {
            if (error instanceof PlatformError) {
                throw error;
            }

            throw new PlatformError(
                "UnsupportedWhere",
                `Unsupported where expression: ${error instanceof Error ? error.message : String(error)}`,
                { cause: error },
            );
        }
    }

    if (request.attributes.id !== undefined) {
        terms.push(
            propertyPredicate(field(["id"]), {
                name: "id",
                attributes: request.propertyAttributes.id ?? {},
                value: request.attributes.id,
            }),
        );
    }

    if (request.attributes.idlist !== undefined) {
        if (request.attributes.idlist.length > queryTextMax) {
            throw new PlatformError("InvalidSelector", "idlist exceeds its input limit.");
        }

        const ids = request.attributes.idlist
            .split(",")
            .map((id) => id.trim())
            .filter(Boolean);
        terms.push(setPredicate(field(["id"]), ids));
    }

    if ((request.attributes.action ?? "get") === "get") {
        terms.push(...(await getCriteria(storage, definition, request, context, apply)));
    }

    const predicate = conjunction(terms);
    validatePredicate(predicate);

    if (definition.isVersionable && !mentionsGeneration(predicate)) {
        return conjunction([predicate, comparison(field(["is_current"]), Comparison.Equal, 1)]);
    }

    return predicate;
}

async function logicalPredicate(
    storage: HarnessStorage,
    definition: ItemTypeDefinition,
    group: AmlLogicalGroup,
    context: ExecutionContext,
    apply: ApplyQueryItem,
): Promise<Predicate> {
    interface Frame {
        readonly group: AmlLogicalGroup;
        readonly terms: Predicate[];
        index: number;
    }

    const pending: Frame[] = [{ group, terms: [], index: 0 }];
    let visited = 0;

    while (pending.length > 0) {
        const frame = pending.at(-1);

        if (!frame || pending.length > queryDepthMax || ++visited > queryNodesMax * 2) {
            throw new PlatformError(
                "UnsupportedCondition",
                "Logical criteria exceed their nesting limit.",
            );
        }

        spendContext(context);
        const term = frame.group.terms[frame.index++];

        if (!term) {
            const result = groupPredicate(frame.group.operator, frame.terms);
            pending.pop();
            const parent = pending.at(-1);

            if (!parent) {
                return result;
            }

            parent.terms.push(result);
        } else if ("operator" in term) {
            pending.push({ group: term, terms: [], index: 0 });
        } else if (term.item) {
            frame.terms.push(await nestedPredicate(storage, definition, term, context, apply));
        } else {
            frame.terms.push(
                propertyPredicate(resolveField(storage, definition, [term.name]), term),
            );
        }
    }

    throw new Error("A logical query must produce one predicate.");
}

function groupPredicate(operator: AmlLogicalOperator, terms: readonly Predicate[]): Predicate {
    if (terms.length === 0) {
        throw new PlatformError("InvalidSelector", "Logical groups must contain criteria.");
    }

    if (operator === AmlLogicalOperator.Not) {
        return { kind: "not", term: conjunction(terms) };
    }

    return { kind: operator, terms };
}

async function nestedPredicate(
    storage: HarnessStorage,
    definition: ItemTypeDefinition,
    condition: AmlPropertyCondition,
    context: ExecutionContext,
    apply: ApplyQueryItem,
): Promise<Predicate> {
    selectorType(storage, definition, condition);
    const selector = condition.item;

    if (!selector) {
        throw new Error("A validated item selector must retain its request.");
    }

    const operator = (condition.attributes.condition ?? "eq").toLowerCase();
    const result = await apply(new Item({ items: [selector] }), context);
    requireSuccess(result);
    const ids = result.payload.items.map((node) => node.attributes.id ?? "");

    return setPredicate(
        resolveField(storage, definition, [condition.name]),
        ids,
        operator === "ne" || operator === "not in",
    );
}

function mentionsGeneration(root: Predicate): boolean {
    const pending = [root];

    while (pending.length > 0) {
        const node = pending.pop();

        if (!node) {
            throw new Error("A predicate must exist while field inspection is pending.");
        }

        if (node.kind === "and" || node.kind === "or") {
            pending.push(...node.terms);
        } else if (node.kind === "not") {
            pending.push(node.term);
        } else if (
            node.kind !== "constant" &&
            node.field.path.length === 0 &&
            ["id", "generation", "is_current"].includes(node.field.name)
        ) {
            return true;
        }
    }

    return false;
}

async function getCriteria(
    storage: HarnessStorage,
    definition: ItemTypeDefinition,
    request: ItemNode,
    context: ExecutionContext,
    apply: ApplyQueryItem,
): Promise<Predicate[]> {
    const terms: Predicate[] = [];
    const field = (names: readonly string[]) => resolveField(storage, definition, names);

    for (const [name, value] of Object.entries(request.properties)) {
        if (name === "id" && request.attributes.id !== undefined && value === "") {
            continue;
        }

        terms.push(
            propertyPredicate(field([name]), {
                name,
                value,
                attributes: request.propertyAttributes[name] ?? {},
            }),
        );
    }

    for (const [name, item] of Object.entries(request.propertyItems)) {
        terms.push(
            await nestedPredicate(
                storage,
                definition,
                { name, item, attributes: request.propertyAttributes[name] ?? {} },
                context,
                apply,
            ),
        );
    }

    for (const group of request.logical ?? []) {
        terms.push(await logicalPredicate(storage, definition, group, context, apply));
    }

    return terms;
}
