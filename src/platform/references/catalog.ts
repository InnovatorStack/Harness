import { spendContext } from "../../core/context.js";
import { dataNodesMax } from "../../core/limits.js";
import type { ExecutionContext } from "../../core/types.js";
import type {
    CatalogEntry,
    HarnessStorage,
    ItemTypeDefinition,
    PropertyDefinition,
    StoredItem,
} from "../../storage/types.js";
import { PlatformError } from "../errors.js";

export interface IncomingReference {
    readonly definition: ItemTypeDefinition;
    readonly property: PropertyDefinition;
    readonly record: StoredItem;
}

export function recordKey(record: Pick<StoredItem, "type" | "id">): string {
    return JSON.stringify([record.type.toLowerCase(), record.id.toLowerCase()]);
}

export class ReferenceCatalog {
    constructor(private readonly storage: HarnessStorage) {}

    dependent(definition: ItemTypeDefinition): boolean {
        const value = this.storage.getCatalogEntry("ItemType", definition.id)?.properties
            .is_dependent;

        if (value !== undefined && value !== null && !["0", "1"].includes(String(value))) {
            throw new PlatformError(
                "InvalidDependency",
                `Invalid is_dependent on '${definition.name}'.`,
            );
        }

        return String(value ?? "0") === "1";
    }

    relationship(definition: ItemTypeDefinition): CatalogEntry | undefined {
        const candidates = this.storage
            .listCatalogEntries("RelationshipType")
            .filter(
                (entry) =>
                    String(entry.properties.relationship_id).toLowerCase() ===
                    definition.id.toLowerCase(),
            );

        if (candidates.length > 1) {
            throw new PlatformError(
                "AmbiguousRelationship",
                `Multiple RelationshipTypes own '${definition.name}'.`,
            );
        }

        return candidates[0];
    }

    target(property: PropertyDefinition): ItemTypeDefinition | undefined {
        if (property.dataType !== "item" || !property.dataSource) {
            return undefined;
        }

        return this.storage
            .listItemTypes()
            .find(
                (definition) => definition.id.toLowerCase() === property.dataSource?.toLowerCase(),
            );
    }

    *incoming(
        target: StoredItem,
        context: ExecutionContext,
        ids: ReadonlySet<string> = new Set([target.id.toLowerCase()]),
    ): Generator<IncomingReference, void, void> {
        const definition = this.storage.getItemType(target.type);

        if (!definition) {
            throw new PlatformError(
                "MissingItemType",
                `Reference target '${target.type}' has no schema.`,
            );
        }

        for (const source of this.storage.listItemTypes()) {
            spendContext(context, source.properties.length + 1);
            const properties = source.properties.filter(
                (property) =>
                    property.dataType === "item" &&
                    property.name !== "config_id" &&
                    property.dataSource?.toLowerCase() === definition.id.toLowerCase(),
            );

            if (properties.length === 0) {
                continue;
            }

            for (const record of this.storage.listItems(source.name)) {
                spendContext(context, properties.length + 1);

                for (const property of properties) {
                    if (ids.has(String(record.properties[property.name]).toLowerCase())) {
                        yield { definition: source, property, record };
                    }
                }
            }
        }
    }

    *owned(parent: StoredItem, context: ExecutionContext): Generator<StoredItem, void, void> {
        const definition = this.storage.getItemType(parent.type);

        if (!definition) {
            throw new PlatformError(
                "MissingItemType",
                `Relationship owner '${parent.type}' has no schema.`,
            );
        }

        for (const incoming of this.incoming(parent, context)) {
            if (incoming.definition.isRelationship && incoming.property.name === "source_id") {
                yield incoming.record;
            }
        }
    }

    hasOwner(record: StoredItem, context: ExecutionContext): boolean {
        const pending = [...this.family(record)];
        const visited = new Set<string>();

        while (pending.length > 0) {
            const target = pending.pop();

            if (!target || visited.size >= dataNodesMax) {
                throw new PlatformError(
                    "ProtocolLimit",
                    "Dependent ownership exceeds its graph budget.",
                );
            }

            const key = recordKey(target);

            if (visited.has(key)) {
                continue;
            }

            visited.add(key);
            spendContext(context);

            for (const owner of this.owners(target, context)) {
                const type = this.storage.getItemType(owner.type);

                if (!type) {
                    throw new PlatformError(
                        "MissingItemType",
                        `Reference owner '${owner.type}' has no schema.`,
                    );
                }

                if (!this.dependent(type) && !type.isRelationship) {
                    return true;
                }

                pending.push(...this.family(owner));
            }
        }

        return false;
    }

    family(record: StoredItem): readonly StoredItem[] {
        const definition = this.storage.getItemType(record.type);

        if (!definition?.isVersionable) {
            return [record];
        }

        const configId = String(record.properties.config_id ?? record.id).toLowerCase();

        return this.storage
            .listItems(record.type)
            .filter(
                (candidate) =>
                    String(candidate.properties.config_id ?? candidate.id).toLowerCase() ===
                    configId,
            );
    }

    current(record: StoredItem): StoredItem {
        const definition = this.storage.getItemType(record.type);

        if (!definition?.isVersionable) {
            const current = this.storage.getItem(record.type, record.id);

            if (!current) {
                throw new PlatformError(
                    "MissingItem",
                    `Reference target '${record.type}:${record.id}' disappeared.`,
                );
            }

            return current;
        }

        const current = this.family(record).filter(
            (candidate) => String(candidate.properties.is_current) === "1",
        );
        const result = current[0];

        if (current.length !== 1 || !result) {
            throw new PlatformError(
                "InvalidGeneration",
                `Reference family '${record.type}:${record.properties.config_id}' needs one current generation.`,
            );
        }

        return result;
    }

    private *owners(
        record: StoredItem,
        context: ExecutionContext,
    ): Generator<StoredItem, void, void> {
        const definition = this.storage.getItemType(record.type);

        if (definition?.isRelationship) {
            const parent = this.parent(definition, record);

            if (parent) {
                yield parent;
            }
        }

        for (const incoming of this.incoming(record, context)) {
            if (incoming.definition.isRelationship && incoming.property.name === "source_id") {
                continue;
            }

            const owner = incoming.definition.isRelationship
                ? this.parent(incoming.definition, incoming.record)
                : incoming.record;

            if (owner) {
                yield owner;
            }
        }
    }

    private parent(definition: ItemTypeDefinition, record: StoredItem): StoredItem | undefined {
        const source = definition.properties.find((property) => property.name === "source_id");
        const type = source ? this.target(source) : undefined;
        const id = record.properties.source_id;

        return type && typeof id === "string" ? this.storage.getItem(type.name, id) : undefined;
    }
}
