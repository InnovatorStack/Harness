import { dataDepthMax } from "../../core/limits.js";
import type {
    HarnessStorage,
    ItemTypeDefinition,
    PropertyDefinition,
    StoredItem,
} from "../../storage/types.js";
import { PlatformError } from "../errors.js";
import { ReferenceBehavior, hardBehavior, referenceBehavior } from "./behavior.js";
import { recordKey } from "./catalog.js";
import type { ReferenceCatalog } from "./catalog.js";

/** Metadata controls reference behavior; no consumer policy configuration is required. */
export class ReferencePolicies {
    constructor(
        private readonly storage: HarnessStorage,
        private readonly catalog: ReferenceCatalog,
    ) {}

    property(property: PropertyDefinition): ReferenceBehavior {
        if (property.name === "config_id" || property.name === "source_id" || !property.id) {
            return ReferenceBehavior.Fixed;
        }

        const metadata = this.storage.getCatalogEntry("Property", property.id);
        const configured = referenceBehavior(metadata?.properties.item_behavior);

        if (configured !== undefined) {
            return configured;
        }

        const defaults = this.storage
            .getItemType("Property")
            ?.properties.find((property) => property.name === "item_behavior")?.defaultValue;

        return referenceBehavior(defaults) ?? ReferenceBehavior.Float;
    }

    relationship(definition: ItemTypeDefinition, record: StoredItem): ReferenceBehavior {
        const template = referenceBehavior(
            this.catalog.relationship(definition)?.properties.behavior,
        );
        const instance = referenceBehavior(record.properties.behavior);

        if (template !== undefined && hardBehavior(template)) {
            return template;
        }

        if (instance !== undefined && hardBehavior(instance)) {
            return instance;
        }

        const source = this.source(definition, record);
        const state = this.storage.getCatalogEntry(
            "Life Cycle State",
            String(source?.properties.current_state ?? ""),
        );
        const configured = referenceBehavior(state?.properties.item_behavior);

        return configured ?? instance ?? template ?? ReferenceBehavior.Fixed;
    }

    historical(definition: ItemTypeDefinition, record: StoredItem): boolean {
        const visited = new Set<string>();
        let current: StoredItem | undefined = record;
        let type: ItemTypeDefinition | undefined = definition;

        while (current && type) {
            const key = recordKey(current);

            if (visited.has(key) || visited.size >= dataDepthMax) {
                throw new PlatformError(
                    "RelationshipCycle",
                    "Reference ownership is cyclic or too deep.",
                );
            }

            visited.add(key);

            if (type.isVersionable && String(current.properties.is_current) === "0") {
                return true;
            }

            if (!type.isRelationship) {
                return false;
            }

            current = this.source(type, current);
            type = current ? this.storage.getItemType(current.type) : undefined;
        }

        return false;
    }

    private source(definition: ItemTypeDefinition, record: StoredItem): StoredItem | undefined {
        const property = definition.properties.find((property) => property.name === "source_id");
        const target = property ? this.catalog.target(property) : undefined;
        const id = record.properties.source_id;

        if (typeof id !== "string" || !target) {
            return undefined;
        }

        const source = this.storage.getItem(target.name, id);

        if (!source) {
            throw new PlatformError(
                "MissingReference",
                `Relationship '${record.type}:${record.id}' has no source '${id}'.`,
            );
        }

        return source;
    }
}
