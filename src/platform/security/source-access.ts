import { spendContext } from "../../core/context.js";
import { dataDepthMax } from "../../core/limits.js";
import type { ExecutionContext } from "../../core/types.js";
import type {
    HarnessStorage,
    ItemTypeDefinition,
    StorageValue,
    StoredItem,
} from "../../storage/types.js";
import { PlatformError } from "../errors.js";
import { recordKey, ReferenceCatalog } from "../references/catalog.js";

interface PermissionSource {
    readonly definition: ItemTypeDefinition;
    readonly record: StoredItem;
}

/** Static preflight and runtime reads enforce the same metadata contract. */
export function sourceAccessEnabled(
    definition: Pick<ItemTypeDefinition, "name" | "isRelationship" | "source">,
    value: StorageValue | undefined,
): boolean {
    if (value !== undefined && value !== null && !["0", "1"].includes(String(value))) {
        throw new PlatformError(
            "InvalidSourceAccess",
            `Invalid use_src_access on '${definition.name}'.`,
            definition.source ? { source: definition.source } : undefined,
        );
    }

    if (String(value ?? "0") === "1" && !definition.isRelationship) {
        throw new PlatformError(
            "UnsupportedSourceAccess",
            `Source access requires a relationship ItemType; '${definition.name}' is not one.`,
            definition.source ? { source: definition.source } : undefined,
        );
    }

    return String(value ?? "0") === "1";
}

/** Resolve read authority through stored source IDs without invoking business get hooks. */
export class SourceAccess {
    private readonly references: ReferenceCatalog;

    constructor(private readonly storage: HarnessStorage) {
        this.references = new ReferenceCatalog(storage);
    }

    inherited(definition: ItemTypeDefinition): boolean {
        const value = this.storage.getCatalogEntry("ItemType", definition.id)?.properties
            .use_src_access;

        return sourceAccessEnabled(definition, value);
    }

    resolve(
        definition: ItemTypeDefinition,
        record: StoredItem,
        context: ExecutionContext,
    ): PermissionSource {
        let current = { definition, record };

        if (!this.inherited(definition)) {
            return current;
        }

        const visited = new Set<string>();

        while (this.inherited(current.definition)) {
            spendContext(context);
            const key = recordKey(current.record);

            if (visited.has(key)) {
                throw new PlatformError(
                    "SourceAccessCycle",
                    `Source permissions form a cycle at '${current.record.type}:${current.record.id}'.`,
                    current.definition.source ? { source: current.definition.source } : undefined,
                );
            }

            if (visited.size >= dataDepthMax) {
                throw new PlatformError(
                    "ProtocolLimit",
                    "Source permissions exceed their depth limit.",
                );
            }

            visited.add(key);
            current = this.parent(current, context);
        }

        return current;
    }

    private parent(current: PermissionSource, context: ExecutionContext): PermissionSource {
        const source = current.definition.properties.find(
            (property) => property.name === "source_id",
        );
        spendContext(context, this.storage.listItemTypes().length);
        const definition = source ? this.references.target(source) : undefined;
        const id = current.record.properties.source_id;

        if (!definition || typeof id !== "string" || !id) {
            throw new PlatformError(
                "InvalidSourceAccess",
                `Relationship '${current.definition.name}' requires a typed source_id to resolve its permissions.`,
                current.definition.source ? { source: current.definition.source } : undefined,
            );
        }

        const record = this.storage.getItem(definition.name, id);

        if (!record) {
            throw new PlatformError(
                "MissingSourceItem",
                `Permission source '${definition.name}:${id}' for '${current.record.type}:${current.record.id}' is missing.`,
                current.definition.source ? { source: current.definition.source } : undefined,
            );
        }

        return { definition, record };
    }
}
