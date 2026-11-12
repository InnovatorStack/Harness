import { assertActiveContext, spendContext } from "../../core/context.js";
import type { ExecutionContext } from "../../core/types.js";
import type {
    HarnessStorage,
    ItemTypeDefinition,
    StorageValue,
    StoredItem,
} from "../../storage/types.js";
import { PlatformError } from "../errors.js";
import type { PlatformTrace } from "../trace.js";
import { ReferenceBehavior, floats } from "./behavior.js";
import { ReferenceCatalog } from "./catalog.js";
import { ReferencePolicies } from "./policy.js";
import { ReferenceSessions } from "./sessions.js";

/** Reference maintenance is a platform write, sharing its caller's transaction and trace. */
export class ReferenceMaintenance {
    readonly catalog: ReferenceCatalog;
    readonly policies: ReferencePolicies;
    readonly sessions: ReferenceSessions;

    constructor(
        private readonly storage: HarnessStorage,
        private readonly trace: PlatformTrace,
    ) {
        this.catalog = new ReferenceCatalog(storage);
        this.policies = new ReferencePolicies(storage, this.catalog);
        this.sessions = new ReferenceSessions(storage, this.catalog);
    }

    initialize(definition: ItemTypeDefinition, record: StoredItem): StoredItem {
        if (!definition.isRelationship) {
            return record;
        }

        return {
            ...record,
            properties: {
                ...record.properties,
                behavior: this.policies.relationship(definition, record),
            },
        };
    }

    versioned(previous: StoredItem, current: StoredItem, context: ExecutionContext): void {
        if (this.storage.getItemType(previous.type)?.isRelationship) {
            this.freeze(previous, context);
        }

        const ids = new Set(this.catalog.family(previous).map((record) => record.id.toLowerCase()));

        for (const incoming of this.catalog.incoming(previous, context, ids)) {
            const { definition, property, record } = incoming;

            if (this.policies.historical(definition, record) || property.name === "source_id") {
                continue;
            }

            const behavior =
                definition.isRelationship && property.name === "related_id"
                    ? this.policies.relationship(definition, record)
                    : this.policies.property(property);

            if (floats(behavior)) {
                this.change(record, { [property.name]: current.id }, "float", context);
            }
        }
    }

    copied(
        definition: ItemTypeDefinition,
        record: StoredItem,
        parentId: string,
        resetBehavior = false,
    ): Readonly<Record<string, StorageValue>> {
        const properties: Record<string, StorageValue> = {
            ...record.properties,
            source_id: parentId,
        };

        if (resetBehavior) {
            properties.behavior = null;
        }

        const related = definition.properties.find((property) => property.name === "related_id");
        const target = related ? this.catalog.target(related) : undefined;
        const id = properties.related_id;

        if (target && typeof id === "string" && id !== "") {
            const existing = this.storage.getItem(target.name, id);

            if (!existing) {
                throw new PlatformError(
                    "MissingReference",
                    `Copied relationship '${record.type}:${record.id}' points to missing '${target.name}:${id}'.`,
                );
            }

            properties.related_id = this.catalog.current(existing).id;
        }

        return this.initialize(definition, { ...record, properties }).properties;
    }

    freeze(record: StoredItem, context: ExecutionContext): void {
        this.change(record, { behavior: ReferenceBehavior.HardFixed }, "freeze", context);
    }

    promoted(parent: StoredItem, context: ExecutionContext): void {
        for (const record of this.catalog.owned(parent, context)) {
            spendContext(context);
            const definition = this.storage.getItemType(record.type);

            if (!definition) {
                throw new PlatformError(
                    "MissingItemType",
                    `Relationship '${record.type}' has no schema.`,
                );
            }

            const behavior = this.policies.relationship(definition, record);
            const changes: Record<string, StorageValue> = { behavior };
            const property = definition.properties.find(
                (property) => property.name === "related_id",
            );
            const target = property ? this.catalog.target(property) : undefined;
            const id = record.properties.related_id;

            if (floats(behavior) && target && typeof id === "string" && id !== "") {
                const referenced = this.storage.getItem(target.name, id);

                if (!referenced) {
                    throw new PlatformError(
                        "MissingReference",
                        `Relationship '${record.type}:${record.id}' has a missing related Item.`,
                    );
                }

                changes.related_id = this.catalog.current(referenced).id;
            }

            this.change(record, changes, "reference-policy", context);
        }
    }

    private change(
        record: StoredItem,
        values: Readonly<Record<string, StorageValue>>,
        name: string,
        context: ExecutionContext,
    ): void {
        const before = this.storage.getItem(record.type, record.id);

        if (!before) {
            throw new PlatformError(
                "MissingItem",
                `Reference source '${record.type}:${record.id}' disappeared.`,
            );
        }

        if (Object.entries(values).every(([name, value]) => before.properties[name] === value)) {
            return;
        }

        assertActiveContext(context);
        this.storage.updateItem(record.type, record.id, values);
        const after = this.storage.getItem(record.type, record.id);

        if (!after) {
            throw new Error("Reference maintenance must retain its source record.");
        }

        this.trace.record(context, { kind: "mutation", name, before, after });
    }
}
