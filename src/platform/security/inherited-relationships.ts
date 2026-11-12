import { spendContext } from "../../core/context.js";
import { dataNodesMax } from "../../core/limits.js";
import type { ExecutionContext } from "../../core/types.js";
import type { HarnessStorage, ItemTypeDefinition, StoredItem } from "../../storage/types.js";
import { PlatformError } from "../errors.js";
import type { SourceAccess } from "./source-access.js";

/** Ownership is stable during synchronous ACL propagation; index each relevant table once. */
export class InheritedRelationships {
    private readonly types = new Map<string, ItemTypeDefinition[]>();
    private readonly records = new Map<string, ReadonlyMap<string, readonly StoredItem[]>>();
    private indexed = 0;

    constructor(
        private readonly storage: HarnessStorage,
        sources: SourceAccess,
        private readonly context: ExecutionContext,
    ) {
        for (const definition of storage.listItemTypes()) {
            spendContext(context, definition.properties.length + 1);

            if (!definition.isRelationship || !sources.inherited(definition)) {
                continue;
            }

            const source = definition.properties.find((property) => property.name === "source_id");
            const sourceType =
                source?.dataType === "item" ? (source.dataSource?.toLowerCase() ?? "") : "";
            const siblings = this.types.get(sourceType) ?? [];
            siblings.push(definition);
            this.types.set(sourceType, siblings);
        }
    }

    *children(parent: StoredItem): Generator<StoredItem, void, void> {
        const owner = this.storage.getItemType(parent.type);

        if (!owner) {
            throw new PlatformError(
                "MissingItemType",
                `Permission source '${parent.type}' has no schema.`,
            );
        }

        const types = [
            ...(this.types.get(owner.id.toLowerCase()) ?? []),
            ...(this.types.get("") ?? []),
        ];

        for (const definition of types) {
            spendContext(this.context);
            const records = this.bySource(definition).get(parent.id.toLowerCase()) ?? [];
            const source = definition.properties.find((property) => property.name === "source_id");

            if (records.length > 0 && (source?.dataType !== "item" || !source.dataSource)) {
                throw new PlatformError(
                    "UnsupportedSourceAccess",
                    `Propagating permissions to '${definition.name}' requires for_all source-type resolution.`,
                    definition.source ? { source: definition.source } : undefined,
                );
            }

            yield* records;
        }
    }

    private bySource(definition: ItemTypeDefinition): ReadonlyMap<string, readonly StoredItem[]> {
        const cached = this.records.get(definition.id);

        if (cached) {
            return cached;
        }

        const index = new Map<string, StoredItem[]>();

        for (const record of this.storage.listItems(definition.name)) {
            spendContext(this.context);
            this.indexed += 1;

            if (this.indexed > dataNodesMax) {
                throw new PlatformError(
                    "ProtocolLimit",
                    "Inherited permissions exceed their ownership index limit.",
                );
            }

            const source = record.properties.source_id;

            if (typeof source !== "string" || !source) {
                continue;
            }

            const key = source.toLowerCase();
            const siblings = index.get(key) ?? [];
            siblings.push(record);
            index.set(key, siblings);
        }

        this.records.set(definition.id, index);

        return index;
    }
}
