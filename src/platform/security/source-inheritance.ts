import { assertActiveContext, spendContext } from "../../core/context.js";
import { dataNodesMax } from "../../core/limits.js";
import type { ExecutionContext } from "../../core/types.js";
import type { HarnessStorage, StorageValue, StoredItem } from "../../storage/types.js";
import { PlatformError } from "../errors.js";
import { recordKey } from "../references/catalog.js";
import type { PlatformTrace } from "../trace.js";
import { InheritedRelationships } from "./inherited-relationships.js";
import type { ItemPermissions } from "./permissions.js";
import type { SourceAccess } from "./source-access.js";

const inheritedFields = ["permission_id", "owned_by_id", "managed_by_id", "team_id"];

/** Audit fields belong to the relationship; these four fields inherit from its source. */
export function inheritedSecurity(source: StoredItem): Record<string, StorageValue> {
    const values: Record<string, StorageValue> = {};

    for (const name of inheritedFields) {
        values[name] = source.properties[name] ?? null;
    }

    return values;
}

/** Native ACL propagation is a platform write in the original action's transaction. */
export class SourceInheritance {
    constructor(
        private readonly storage: HarnessStorage,
        private readonly sources: SourceAccess,
        private readonly trace: PlatformTrace,
        private readonly permissions: ItemPermissions,
    ) {}

    changed(before: StoredItem, after: StoredItem, context: ExecutionContext): void {
        const fields = inheritedFields.filter(
            (name) => (before.properties[name] ?? null) !== (after.properties[name] ?? null),
        );

        if (fields.length === 0) {
            return;
        }

        const definition = this.storage.getItemType(after.type);

        if (!definition) {
            throw new PlatformError(
                "MissingItemType",
                `Permission source '${after.type}' has no schema.`,
            );
        }

        const inherited = this.permissions.sourceProperties(definition, after, context);
        const changes: Record<string, StorageValue> = {
            permission_id: inherited.permission_id ?? null,
        };

        for (const name of fields) {
            changes[name] = after.properties[name] ?? null;
        }

        this.propagate(after, changes, context);
    }

    private propagate(
        source: StoredItem,
        changes: Readonly<Record<string, StorageValue>>,
        context: ExecutionContext,
    ): void {
        const pending = [source];
        const visited = new Set<string>();
        const relationships = new InheritedRelationships(this.storage, this.sources, context);

        while (pending.length > 0) {
            spendContext(context);
            const parent = pending.pop();

            if (!parent || visited.size >= dataNodesMax) {
                throw new PlatformError(
                    "ProtocolLimit",
                    "Inherited permissions exceed their graph limit.",
                );
            }

            const key = recordKey(parent);

            if (visited.has(key)) {
                throw new PlatformError(
                    "SourceAccessCycle",
                    "Inherited permissions contain a cycle.",
                );
            }

            visited.add(key);

            for (const child of relationships.children(parent)) {
                if (pending.length >= dataNodesMax) {
                    throw new PlatformError(
                        "ProtocolLimit",
                        "Inherited permissions exceed their pending graph limit.",
                    );
                }

                pending.push(this.update(child, changes, context));
            }
        }
    }

    private update(
        before: StoredItem,
        changes: Readonly<Record<string, StorageValue>>,
        context: ExecutionContext,
    ): StoredItem {
        if (Object.entries(changes).every(([name, value]) => before.properties[name] === value)) {
            return before;
        }

        assertActiveContext(context);
        this.storage.updateItem(before.type, before.id, changes);
        const after = this.storage.getItem(before.type, before.id);

        if (!after) {
            throw new Error("Permission propagation must retain its relationship.");
        }

        this.trace.record(context, {
            kind: "mutation",
            name: "inherit-permissions",
            before,
            after,
        });

        return after;
    }
}
