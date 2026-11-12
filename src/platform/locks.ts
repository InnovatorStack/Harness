import { assertActiveContext } from "../core/context.js";
import type { ExecutionContext } from "../core/types.js";
import { Item } from "../items/item.js";
import type { SelectQuery } from "../queries/types.js";
import type { HarnessStorage, ItemTypeDefinition, StoredItem } from "../storage/types.js";
import { PlatformError, requireSuccess } from "./errors.js";
import type { RunEvents } from "./events/types.js";
import { projectItem } from "./projection.js";
import type { ReferenceCatalog } from "./references/catalog.js";
import type { PlatformTrace } from "./trace.js";
import { ItemUnlocks } from "./unlocking.js";
import { manualVersioning } from "./version-policy.js";

/** Locks are database state, so nested calls and transaction rollback see the same owner. */
export class ItemLocks {
    private readonly unlocks: ItemUnlocks;

    constructor(
        private readonly storage: HarnessStorage,
        private readonly trace: PlatformTrace,
        private readonly events: RunEvents,
        private readonly userId: (() => string) | undefined,
        private readonly dispatch: (item: Item, context: ExecutionContext) => Promise<Item>,
        catalog: ReferenceCatalog,
        select?: SelectQuery,
    ) {
        this.unlocks = new ItemUnlocks(storage, trace, events, () => this.owner(), catalog, select);
    }

    async unlockVersionSources(
        definition: ItemTypeDefinition,
        sources: readonly StoredItem[],
        context: ExecutionContext,
    ): Promise<void> {
        await this.unlocks.unlockVersionSources(definition, sources, context);
    }

    async unlockAfterEdit(
        definition: ItemTypeDefinition,
        records: readonly StoredItem[],
        request: Item,
        context: ExecutionContext,
    ): Promise<void> {
        await this.unlocks.unlockVersionSources(definition, records, context, request);
    }

    async lockForEdit(
        definition: ItemTypeDefinition,
        records: readonly StoredItem[],
        request: Item,
        context: ExecutionContext,
    ): Promise<void> {
        for (const record of records) {
            this.assertLockable(record);
        }

        if (records.some((record) => Boolean(record.properties.locked_by_id))) {
            return;
        }

        const event = request.clone();
        delete event.node.attributes.where;
        delete event.node.attributes.idlist;

        for (const record of records) {
            event.setProperty("id", record.id);
            await this.events(definition, "onBeforeLock", event, true, context);
            this.assertEditContext(definition, request, event, record.id);
        }

        for (const record of records) {
            this.write(definition, record, "lock", context);
        }

        for (const record of records) {
            event.setProperty("id", record.id);
            await this.events(definition, "onAfterLock", event, true, context);
            this.assertEditContext(definition, request, event, record.id);
        }
    }

    private assertEditContext(
        definition: ItemTypeDefinition,
        request: Item,
        event: Item,
        id: string,
    ): void {
        if (
            event.getType() !== definition.name ||
            event.getAction() !== request.getAction() ||
            event.getID() !== id
        ) {
            throw new PlatformError(
                "UnsupportedContextChange",
                "An implicit lock hook must retain its ItemType, action and target ID.",
            );
        }
    }

    owner(): string {
        const id = this.userId?.();

        if (!id) {
            throw new PlatformError(
                "SessionRequired",
                "Locking and versionable updates require a configured User session.",
            );
        }

        return id;
    }

    assertOwned(record: StoredItem): void {
        const owner = this.owner();

        if (String(record.properties.locked_by_id ?? "").toLowerCase() !== owner.toLowerCase()) {
            throw new PlatformError(
                "LockOwnership",
                `Record '${record.type}:${record.id}' must be locked by the current User before updating.`,
            );
        }
    }

    assertAvailable(record: StoredItem): void {
        const currentOwner = String(record.properties.locked_by_id ?? "");

        if (currentOwner && currentOwner.toLowerCase() !== this.owner().toLowerCase()) {
            throw new PlatformError(
                "LockOwnership",
                `Record '${record.type}:${record.id}' is locked by another User.`,
            );
        }
    }

    private assertLockable(record: StoredItem): void {
        this.assertAvailable(record);

        if (String(record.properties.not_lockable ?? "0") === "1") {
            throw new PlatformError(
                "NotLockable",
                `Record '${record.type}:${record.id}' cannot be locked in its current state.`,
            );
        }
    }

    async apply(
        definition: ItemTypeDefinition,
        record: StoredItem,
        action: "lock" | "unlock",
        context: ExecutionContext,
        enabled = true,
    ): Promise<StoredItem> {
        const request = Item.create(definition.name, action);
        request.setProperty("id", record.id);
        request.setAttribute("doGetItem", "0");

        if (!enabled) {
            request.setAttribute("serverEvents", "0");
        }

        requireSuccess(await this.dispatch(request, context));
        const current = this.storage.getItem(definition.name, record.id);

        if (!current) {
            throw new PlatformError("MissingItem", "The lock target disappeared in its event.");
        }

        return current;
    }

    async base(
        definition: ItemTypeDefinition,
        record: StoredItem,
        action: "lock" | "unlock",
        context: ExecutionContext,
        request: Item,
    ): Promise<Item> {
        this.owner();
        const currentOwner = String(record.properties.locked_by_id ?? "");
        this.assertAvailable(record);

        if (action === "lock" && String(record.properties.not_lockable ?? "0") === "1") {
            throw new PlatformError(
                "NotLockable",
                `Record '${record.type}:${record.id}' cannot be locked in its current state.`,
            );
        }

        if ((action === "lock") === Boolean(currentOwner)) {
            return new Item({
                items: [
                    projectItem(this.storage, definition, record, request.node.attributes.select),
                ],
            });
        }

        const verb = action === "lock" ? "Lock" : "Unlock";

        const event = request.clone();
        event.setProperty("id", record.id);
        delete event.node.attributes.where;
        delete event.node.attributes.idlist;
        const enabled = request.getAttribute("serverEvents") !== "0";
        await this.events(definition, `onBefore${verb}`, event, enabled, context);

        if (
            event.getType() !== definition.name ||
            event.getAction() !== action ||
            event.getID() !== record.id
        ) {
            throw new PlatformError(
                "UnsupportedContextChange",
                "A lock event cannot change the ItemType, action or target ID.",
            );
        }

        const after = this.write(definition, record, action, context);
        const response = new Item({
            items: [projectItem(this.storage, definition, after, request.node.attributes.select)],
        });
        await this.events(definition, `onAfter${verb}`, response, enabled, context);

        return response;
    }

    private write(
        definition: ItemTypeDefinition,
        record: StoredItem,
        action: "lock" | "unlock",
        context: ExecutionContext,
    ): StoredItem {
        assertActiveContext(context);
        this.storage.updateItem(definition.name, record.id, {
            locked_by_id: action === "lock" ? this.owner() : null,
            ...(action === "unlock" &&
            definition.isVersionable &&
            !manualVersioning(this.storage, definition)
                ? { new_version: 0 }
                : {}),
        });
        const after = this.storage.getItem(definition.name, record.id);

        if (!after) {
            throw new PlatformError("MissingItem", "Locked record disappeared.");
        }

        this.trace.record(context, { kind: "mutation", name: action, before: record, after });

        return after;
    }
}
