import { spendContext } from "../core/context.js";
import { setOwn } from "../core/data.js";
import type { ExecutionContext } from "../core/types.js";
import { Item } from "../items/item.js";
import type { ItemNode } from "../items/item.js";
import type { HarnessStorage, ItemTypeDefinition } from "../storage/types.js";
import { PlatformError, requireSuccess } from "./errors.js";
import type { ApplyQueryItem } from "./queries/planner.js";
import { relationshipType } from "./relationship-type.js";

export type RelationshipCopies = ReadonlyMap<string, string>;

export function relationshipKey(type: string, id: string): string {
    return JSON.stringify([type.toLowerCase(), id.toLowerCase()]);
}

/** Nested actions use the same runtime as root actions, including hooks and rollback. */
export class GraphActions {
    constructor(
        private readonly storage: HarnessStorage,
        private readonly apply: ApplyQueryItem,
    ) {}

    async properties(
        definition: ItemTypeDefinition,
        request: ItemNode,
        context: ExecutionContext,
    ): Promise<void> {
        for (const [name, child] of Object.entries(request.propertyItems)) {
            spendContext(context);
            const property = definition.properties.find((property) => property.name === name);
            const target = this.storage.getItemType(child.type);

            if (
                property?.dataType !== "item" ||
                !target ||
                target.id.toLowerCase() !== property.dataSource?.toLowerCase() ||
                !["get", "add", "edit", "update"].includes(child.attributes.action ?? "get")
            ) {
                throw new PlatformError(
                    "UnsupportedPropertyMutation",
                    `Nested '${definition.name}.${name}' requires an action on its imported ItemType.`,
                );
            }

            const result = requireSuccess(await this.apply(new Item({ items: [child] }), context));
            const record = result.payload.items[0];

            if (
                result.payload.items.length !== 1 ||
                !record?.attributes.id ||
                record.type.toLowerCase() !== target.name.toLowerCase() ||
                !this.storage.getItem(target.name, record.attributes.id)
            ) {
                throw new PlatformError(
                    "ItemResolution",
                    `Nested '${definition.name}.${name}' must resolve one persisted Item.`,
                );
            }

            setOwn(request.properties, name, record.attributes.id);
        }
    }

    async relationships(
        definition: ItemTypeDefinition,
        request: ItemNode,
        parentId: string,
        context: ExecutionContext,
        copies: RelationshipCopies = new Map(),
    ): Promise<ItemNode[]> {
        const children: ItemNode[] = [];
        const targets = new Map(copies);

        for (const original of request.relationships) {
            spendContext(context);
            const child = new Item({ items: [original] }).clone().node;
            const type = relationshipType(this.storage, definition, child.type);
            const action = child.attributes.action ?? "get";

            if (!["add", "edit", "update", "delete", "get"].includes(action)) {
                throw new PlatformError(
                    "UnsupportedRelationships",
                    `Unsupported nested '${action}'.`,
                );
            }

            if (action === "add") {
                this.source(child, parentId);
            } else {
                this.target(type, child, parentId, targets);
            }

            const result = requireSuccess(await this.apply(new Item({ items: [child] }), context));
            this.assertResults(type, result, parentId, action, child.attributes.id);
            const current = result.payload.items[0];

            if (original.attributes.id && current?.attributes.id && action !== "delete") {
                targets.set(
                    relationshipKey(type.name, original.attributes.id),
                    current.attributes.id,
                );
            }

            children.push(...result.payload.items);
        }

        return children;
    }

    private source(child: ItemNode, parentId: string): void {
        const source = child.properties.source_id;

        if (
            Object.hasOwn(child.propertyItems, "source_id") ||
            (source !== undefined && String(source).toLowerCase() !== parentId.toLowerCase())
        ) {
            throw new PlatformError(
                "RelationshipSource",
                "Nested source_id conflicts with its parent.",
            );
        }

        child.properties.source_id = parentId;
    }

    private target(
        definition: ItemTypeDefinition,
        child: ItemNode,
        parentId: string,
        copies: RelationshipCopies,
    ): void {
        const originalId = child.attributes.id;

        if (
            !originalId ||
            child.attributes.where !== undefined ||
            child.attributes.idlist !== undefined
        ) {
            throw new PlatformError(
                "UnsupportedRelationships",
                "Nested relationship mutations require one explicit relationship ID.",
            );
        }

        const id = copies.get(relationshipKey(definition.name, originalId)) ?? originalId;
        const stored = this.storage.getItem(definition.name, id);

        if (String(stored?.properties.source_id).toLowerCase() !== parentId.toLowerCase()) {
            throw new PlatformError(
                "RelationshipSource",
                "Nested relationship belongs to another parent.",
            );
        }

        if (id !== originalId && child.properties.source_id !== undefined) {
            const original = this.storage.getItem(definition.name, originalId);

            if (
                String(child.properties.source_id).toLowerCase() !==
                String(original?.properties.source_id).toLowerCase()
            ) {
                throw new PlatformError(
                    "RelationshipSource",
                    "Invalid copied relationship source.",
                );
            }

            child.properties.source_id = parentId;
        }

        child.attributes.id = id;
        this.source(child, parentId);
    }

    private assertResults(
        definition: ItemTypeDefinition,
        result: Item,
        parentId: string,
        action: string,
        expectedId: string | undefined,
    ): void {
        for (const node of result.payload.items) {
            const stored = this.storage.getItem(definition.name, node.attributes.id ?? "");
            const valid =
                action === "delete"
                    ? stored === undefined && node.attributes.id === expectedId
                    : String(stored?.properties.source_id).toLowerCase() === parentId.toLowerCase();

            if (node.type.toLowerCase() !== definition.name.toLowerCase() || !valid) {
                throw new PlatformError(
                    "RelationshipSource",
                    "Nested action left its parent scope.",
                );
            }
        }
    }
}
