import { spendContext } from "../../core/context.js";
import { dataNodesMax } from "../../core/limits.js";
import type { ExecutionContext } from "../../core/types.js";
import { Item } from "../../items/item.js";
import type { HarnessStorage, StoredItem } from "../../storage/types.js";
import { ApplicationError, PlatformError, requireSuccess } from "../errors.js";
import type { ApplyQueryItem } from "../queries/planner.js";
import { recordKey } from "./catalog.js";
import type { ReferenceCatalog } from "./catalog.js";
import type { ReferenceSessions } from "./sessions.js";

export class DependentDeletion {
    constructor(
        private readonly storage: HarnessStorage,
        private readonly catalog: ReferenceCatalog,
        private readonly sessions: ReferenceSessions,
        private readonly apply: ApplyQueryItem,
        private readonly removeOwned: (
            parent: StoredItem,
            child: StoredItem,
            enabled: boolean,
            context: ExecutionContext,
        ) => Promise<Item>,
    ) {}

    prepare(records: readonly StoredItem[], context: ExecutionContext): void {
        const pending = [...records];
        const visited = new Set<string>();

        while (pending.length > 0) {
            const record = pending.pop();

            if (!record || visited.size >= dataNodesMax) {
                throw new PlatformError("ProtocolLimit", "Deletion exceeds its graph budget.");
            }

            spendContext(context);
            const key = recordKey(record);

            if (visited.has(key)) {
                continue;
            }

            visited.add(key);
            this.sessions.schedule(record, context);
            pending.push(...this.catalog.owned(record, context));
        }
    }

    async children(record: StoredItem, enabled: boolean, context: ExecutionContext): Promise<void> {
        for (const child of this.catalog.owned(record, context)) {
            if (this.storage.getItem(child.type, child.id)) {
                requireSuccess(await this.removeOwned(record, child, enabled, context));
            }
        }
    }

    assertRemovable(record: StoredItem, context: ExecutionContext): void {
        for (const incoming of this.catalog.incoming(record, context)) {
            if (!this.sessions.scheduled(incoming.record, context)) {
                throw new ApplicationError(
                    Item.error(
                        `Cannot delete '${record.type}:${record.id}': referenced by ` +
                            `'${incoming.definition.name}.${incoming.property.name}'.`,
                        "ReferencedItem",
                    ),
                );
            }
        }
    }

    async changed(
        before: StoredItem,
        after: StoredItem | undefined,
        enabled: boolean,
        context: ExecutionContext,
    ): Promise<void> {
        const definition = this.storage.getItemType(before.type);

        if (!definition) {
            throw new PlatformError(
                "MissingItemType",
                `Changed reference source '${before.type}' has no schema.`,
            );
        }

        for (const property of definition.properties) {
            if (property.name === "config_id" || property.name === "source_id") {
                continue;
            }

            const previous = before.properties[property.name];
            const target = this.catalog.target(property);

            if (
                !target ||
                !this.catalog.dependent(target) ||
                typeof previous !== "string" ||
                after?.properties[property.name] === previous
            ) {
                continue;
            }

            const orphan = this.storage.getItem(target.name, previous);

            if (
                orphan &&
                !this.sessions.active(orphan, context) &&
                !this.catalog.hasOwner(orphan, context)
            ) {
                await this.remove(orphan, enabled, context);
            }
        }
    }

    private async remove(
        record: StoredItem,
        enabled: boolean,
        context: ExecutionContext,
    ): Promise<void> {
        const request = Item.create(record.type, "delete");
        request.setProperty("id", record.id);

        if (!enabled) {
            request.setAttribute("serverEvents", "0");
        }

        requireSuccess(await this.apply(request, context));
    }
}
