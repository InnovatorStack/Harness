import { assertActiveContext, spendContext } from "../core/context.js";
import { dataDepthMax, dataNodesMax } from "../core/limits.js";
import type { ExecutionContext } from "../core/types.js";
import { Item } from "../items/item.js";
import { Comparison } from "../queries/types.js";
import type { Predicate, SelectQuery } from "../queries/types.js";
import type { HarnessStorage, ItemTypeDefinition, StoredItem } from "../storage/types.js";
import { PlatformError } from "./errors.js";
import type { RunEvents } from "./events/types.js";
import { recordKey } from "./references/catalog.js";
import type { ReferenceCatalog } from "./references/catalog.js";
import type { PlatformTrace } from "./trace.js";
import { manualVersioning } from "./version-policy.js";

interface DependentRelationship {
    readonly relationship: ItemTypeDefinition;
    readonly related: ItemTypeDefinition;
}

interface UnlockBatch {
    readonly definition: ItemTypeDefinition;
    readonly records: readonly StoredItem[];
    readonly event: Item;
    readonly depth: number;
}

type UnlockTask =
    | { readonly kind: "enter" | "after"; readonly batch: UnlockBatch }
    | {
          readonly kind: "related";
          readonly parent: StoredItem;
          readonly relationship: DependentRelationship;
          readonly depth: number;
      };

/** Internal version/edit cleanup bypasses replacements while retaining native unlock hooks. */
export class ItemUnlocks {
    constructor(
        private readonly storage: HarnessStorage,
        private readonly trace: PlatformTrace,
        private readonly events: RunEvents,
        private readonly owner: () => string,
        private readonly catalog: ReferenceCatalog,
        private readonly select?: SelectQuery,
    ) {}

    async unlockVersionSources(
        definition: ItemTypeDefinition,
        sources: readonly StoredItem[],
        context: ExecutionContext,
        request?: Item,
    ): Promise<void> {
        const records = sources.filter((record) => Boolean(record.properties.locked_by_id));

        if (records.length === 0) {
            return;
        }

        const outgoing = this.relationships(context);
        const active = new Set<string>();
        const event = request?.clone() ?? Item.create(definition.name);
        delete event.node.attributes.where;
        delete event.node.attributes.idlist;
        const pending: UnlockTask[] = [
            {
                kind: "enter",
                batch: { definition, records, event, depth: 0 },
            },
        ];
        let visited = 0;

        while (pending.length > 0) {
            const task = pending.pop();

            if (!task || ++visited > dataNodesMax || pending.length > dataNodesMax) {
                throw new PlatformError("ProtocolLimit", "Unlocks exceed their graph budget.");
            }

            spendContext(context);

            if (task.kind === "enter") {
                await this.enter(task.batch, active, context);
                pending.push({ kind: "after", batch: task.batch });
                this.scheduleChildren(task.batch, outgoing, pending, context);
            } else if (task.kind === "related") {
                const batch = this.related(task, context);

                if (batch) {
                    pending.push({ kind: "enter", batch });
                }
            } else {
                await this.after(task.batch, active, context);
            }
        }
    }

    private async enter(
        batch: UnlockBatch,
        active: Set<string>,
        context: ExecutionContext,
    ): Promise<void> {
        if (batch.depth > dataDepthMax || active.size + batch.records.length > dataNodesMax) {
            throw new PlatformError(
                "ProtocolLimit",
                "Unlock ownership exceeds its depth or size limit.",
            );
        }

        for (const record of batch.records) {
            const key = recordKey(record);

            if (active.has(key)) {
                throw new PlatformError("RelationshipCycle", "Unlock ownership contains a cycle.");
            }

            active.add(key);
            this.assertOwned(this.current(record));
        }

        for (const record of batch.records) {
            batch.event.setProperty("id", record.id);
            await this.events(batch.definition, "onBeforeUnlock", batch.event, true, context);
        }

        for (const record of batch.records) {
            const before = this.current(record);
            const changes =
                batch.definition.isVersionable && !manualVersioning(this.storage, batch.definition)
                    ? { locked_by_id: null, new_version: 0 }
                    : { locked_by_id: null };
            assertActiveContext(context);
            this.storage.updateItem(batch.definition.name, record.id, changes);
            this.trace.record(context, {
                kind: "mutation",
                name: "unlock",
                before,
                after: this.current(record),
            });
        }
    }

    private async after(
        batch: UnlockBatch,
        active: Set<string>,
        context: ExecutionContext,
    ): Promise<void> {
        for (const record of batch.records) {
            batch.event.setProperty("id", record.id);
            await this.events(batch.definition, "onAfterUnlock", batch.event, true, context);
            active.delete(recordKey(record));
        }
    }

    private scheduleChildren(
        batch: UnlockBatch,
        outgoing: ReadonlyMap<string, readonly DependentRelationship[]>,
        pending: UnlockTask[],
        context: ExecutionContext,
    ): void {
        const relationships = outgoing.get(batch.definition.id.toLowerCase()) ?? [];

        for (const parent of [...batch.records].reverse()) {
            for (const relationship of [...relationships].reverse()) {
                spendContext(context);

                if (pending.length >= dataNodesMax) {
                    throw new PlatformError(
                        "ProtocolLimit",
                        "Unlocks exceed their work queue limit.",
                    );
                }

                pending.push({ kind: "related", parent, relationship, depth: batch.depth + 1 });
            }
        }
    }

    private related(
        task: Extract<UnlockTask, { kind: "related" }>,
        context: ExecutionContext,
    ): UnlockBatch | undefined {
        const { relationship, related } = task.relationship;

        if (!this.catalog.dependent(related)) {
            return undefined;
        }

        const records = new Map<string, StoredItem>();
        const owner = this.owner().toLowerCase();

        for (const link of this.relationshipRows(relationship, task.parent.id, context)) {
            spendContext(context);
            const id = link.properties.related_id;
            const record =
                typeof id === "string" ? this.storage.getItem(related.name, id) : undefined;

            if (record && String(record.properties.locked_by_id ?? "").toLowerCase() === owner) {
                records.set(record.id.toLowerCase(), record);
            }
        }

        if (records.size === 0) {
            return undefined;
        }

        return {
            definition: related,
            records: [...records.values()],
            event: Item.create(related.name),
            depth: task.depth,
        };
    }

    private relationshipRows(
        definition: ItemTypeDefinition,
        sourceId: string,
        context: ExecutionContext,
    ): readonly StoredItem[] {
        const predicate: Predicate = {
            kind: "compare",
            field: { name: "source_id", column: "source_id", kind: "identifier", path: [] },
            operator: Comparison.Equal,
            value: sourceId,
        };
        const candidates = this.select
            ? this.select(definition.name, predicate, (units) => {
                  spendContext(context, units);
              })
            : this.storage.listItems(definition.name);

        return candidates.filter((record) => {
            spendContext(context);

            return (
                String(record.properties.source_id ?? "").toLowerCase() === sourceId.toLowerCase()
            );
        });
    }

    private relationships(
        context: ExecutionContext,
    ): ReadonlyMap<string, readonly DependentRelationship[]> {
        const definitions = this.storage.listItemTypes();
        spendContext(context, definitions.length);
        const types = new Map(
            definitions.map((definition) => [definition.id.toLowerCase(), definition]),
        );
        const outgoing = new Map<string, DependentRelationship[]>();

        for (const entry of this.storage.listCatalogEntries("RelationshipType")) {
            spendContext(context);
            const source = entry.properties.source_id;
            const target = entry.properties.related_id;

            if (typeof source !== "string" || !source || typeof target !== "string" || !target) {
                continue;
            }

            const related = types.get(target.toLowerCase());
            const relationship = types.get(String(entry.properties.relationship_id).toLowerCase());

            if (!related || !relationship) {
                continue;
            }

            const links = outgoing.get(source.toLowerCase()) ?? [];
            links.push({ related, relationship });
            outgoing.set(source.toLowerCase(), links);
        }

        return outgoing;
    }

    private current(record: StoredItem): StoredItem {
        const current = this.storage.getItem(record.type, record.id);

        if (!current) {
            throw new PlatformError("MissingItem", "An unlock target disappeared in its event.");
        }

        return current;
    }

    private assertOwned(record: StoredItem): void {
        if (
            String(record.properties.locked_by_id ?? "").toLowerCase() !==
            this.owner().toLowerCase()
        ) {
            throw new PlatformError(
                "LockOwnership",
                "An internal unlock requires the current User's lock.",
            );
        }
    }
}
