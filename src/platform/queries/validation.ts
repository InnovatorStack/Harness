import type { ItemNode } from "../../items/item.js";
import type { AmlLogicalTerm, AmlPropertyCondition } from "../../items/logical.js";
import { PredicateParser } from "../../queries/parser.js";
import { queryDepthMax, queryNodesMax } from "../../queries/types.js";
import type { HarnessStorage, ItemTypeDefinition } from "../../storage/types.js";
import { PlatformError } from "../errors.js";
import { compileProjection } from "../projection.js";
import { relationshipType } from "../relationship-type.js";
import { validateRequest } from "../request.js";
import { propertyPredicate } from "./conditions.js";
import { resolveField, selectorType } from "./fields.js";
import { orderBy } from "./order.js";
import { pageRows } from "./paging.js";

/** Validate nested queries even when no parent rows exist. This never executes business hooks. */
export function validateEmptyQuery(
    storage: HarnessStorage,
    definition: ItemTypeDefinition,
    request: ItemNode,
): void {
    const pending = [{ definition, request, depth: 0 }];
    let visited = 0;

    while (pending.length > 0) {
        const frame = pending.pop();

        if (!frame || ++visited > queryNodesMax || frame.depth > queryDepthMax) {
            throw new PlatformError(
                "InvalidSelector",
                "Nested query exceeds its traversal budget.",
            );
        }

        const { definition, request, depth } = frame;
        validateRequest(request, "get");
        compileProjection(storage, definition, request.attributes.select);
        orderBy(storage, definition, request.attributes.orderBy);
        pageRows(request, []);

        if (request.attributes.where) {
            new PredicateParser(request.attributes.where, (names) =>
                resolveField(storage, definition, names),
            ).parse();
        }

        for (const property of conditions(request)) {
            if (property.item) {
                pending.push({
                    definition: selectorType(storage, definition, property),
                    request: property.item,
                    depth: depth + 1,
                });
            } else {
                propertyPredicate(resolveField(storage, definition, [property.name]), property);
            }
        }

        for (const child of request.relationships) {
            if ((child.attributes.action ?? "get") !== "get") {
                throw new PlatformError("InvalidSelector", "Nested queries require get actions.");
            }

            pending.push({
                definition: relationshipType(storage, definition, child.type),
                request: child,
                depth: depth + 1,
            });
        }
    }
}

function* conditions(request: ItemNode): Generator<AmlPropertyCondition, void, void> {
    for (const [name, value] of Object.entries(request.properties)) {
        yield { name, value, attributes: request.propertyAttributes[name] ?? {} };
    }

    for (const [name, item] of Object.entries(request.propertyItems)) {
        yield { name, item, attributes: request.propertyAttributes[name] ?? {} };
    }

    const pending: { readonly term: AmlLogicalTerm; readonly depth: number }[] = (
        request.logical ?? []
    ).map((term) => ({ term, depth: 0 }));
    let visited = 0;

    while (pending.length > 0) {
        const frame = pending.pop();

        if (!frame || ++visited > queryNodesMax || frame.depth > queryDepthMax) {
            throw new PlatformError("InvalidSelector", "Logical criteria exceed their budget.");
        }

        if ("operator" in frame.term) {
            if (frame.term.terms.length === 0) {
                throw new PlatformError("InvalidSelector", "Logical groups require criteria.");
            }

            for (const term of frame.term.terms) {
                pending.push({ term, depth: frame.depth + 1 });
            }
        } else {
            yield frame.term;
        }
    }
}
