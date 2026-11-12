import { spendContext } from "../../core/context.js";
import type { ExecutionContext } from "../../core/types.js";
import { Item } from "../../items/item.js";
import type { ItemNode } from "../../items/item.js";
import { AmlLogicalOperator } from "../../items/logical.js";
import type { HarnessStorage, ItemTypeDefinition, StoredItem } from "../../storage/types.js";
import { PlatformError, requireSuccess } from "../errors.js";
import { relationshipType } from "../relationship-type.js";
import type { ApplyQueryItem } from "./planner.js";
import { validateEmptyQuery } from "./validation.js";

export interface RelationshipSelection {
    readonly records: readonly StoredItem[];
    readonly relationships: ReadonlyMap<string, readonly ItemNode[]>;
}

export class RelationshipQueries {
    constructor(
        private readonly storage: HarnessStorage,
        private readonly apply: ApplyQueryItem,
    ) {}

    async select(
        definition: ItemTypeDefinition,
        request: ItemNode,
        records: readonly StoredItem[],
        context: ExecutionContext,
    ): Promise<RelationshipSelection> {
        for (const child of request.relationships) {
            const target = relationshipType(this.storage, definition, child.type);

            if (records.length === 0) {
                validateEmptyQuery(this.storage, target, child);
            }

            if ((child.attributes.action ?? "get") !== "get") {
                throw new PlatformError(
                    "InvalidSelector",
                    "Nested get requires relationship gets.",
                );
            }
        }

        const included: StoredItem[] = [];
        const relationships = new Map<string, readonly ItemNode[]>();

        for (const parent of records) {
            let matches = true;
            const children: ItemNode[] = [];

            for (const child of request.relationships) {
                spendContext(context);
                const result = await this.get(child, parent, context);
                children.push(...result.payload.items);

                if (criteria(child) && result.payload.items.length === 0) {
                    matches = false;
                }
            }

            if (matches) {
                included.push(parent);
                relationships.set(parent.id, children);
            }
        }

        return { records: included, relationships };
    }

    private async get(
        request: ItemNode,
        parent: StoredItem,
        context: ExecutionContext,
    ): Promise<Item> {
        const scoped = structuredClone(request);
        scoped.logical = [
            ...(scoped.logical ?? []),
            {
                operator: AmlLogicalOperator.And,
                terms: [{ name: "source_id", attributes: {}, value: parent.id }],
            },
        ];
        const result = requireSuccess(await this.apply(new Item({ items: [scoped] }), context));

        for (const child of result.payload.items) {
            const stored = this.storage.getItem(request.type, child.attributes.id ?? "");

            if (
                child.type.toLowerCase() !== request.type.toLowerCase() ||
                String(stored?.properties.source_id).toLowerCase() !== parent.id.toLowerCase()
            ) {
                throw new PlatformError(
                    "RelationshipSource",
                    "A nested query returned a relationship outside its parent scope.",
                );
            }
        }

        return result;
    }
}

function criteria(request: ItemNode): boolean {
    const pending = [request];

    while (pending.length > 0) {
        const node = pending.pop();

        if (!node) {
            throw new Error("A relationship criterion must exist while inspection is pending.");
        }

        if (node.attributes.isCriteria === "0") {
            continue;
        }

        if (
            Object.keys(node.properties).length > 0 ||
            Object.keys(node.propertyItems).length > 0 ||
            (node.logical?.length ?? 0) > 0 ||
            ["where", "id", "idlist"].some((name) => node.attributes[name] !== undefined)
        ) {
            return true;
        }

        pending.push(...node.relationships);
    }

    return false;
}
