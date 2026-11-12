import { assertActiveContext, spendContext } from "../core/context.js";
import { dataDepthMax, dataNodesMax } from "../core/limits.js";
import type { ExecutionContext } from "../core/types.js";
import type { HarnessStorage, ItemTypeDefinition, StoredItem } from "../storage/types.js";
import { PlatformError } from "./errors.js";
import { relationshipKey } from "./graph-actions.js";
import { recordKey } from "./references/catalog.js";
import type { ReferenceMaintenance } from "./references/maintenance.js";
import { VersionCopyPolicy } from "./relationship-copy-policy.js";
import { isReleased } from "./revisions/policy.js";
import type { NativeSecurity } from "./security/policy.js";
import type { PlatformTrace } from "./trace.js";
import { manualVersioning } from "./version-policy.js";

interface CopyGroup {
    readonly definition: ItemTypeDefinition;
    readonly records: StoredItem[];
    readonly parentId: string;
    readonly depth: number;
    readonly resetBehavior: boolean;
}

type CopyTask =
    | {
          readonly kind: "owner";
          readonly source: StoredItem;
          readonly targetId: string;
          readonly depth: number;
          readonly resetBehavior: boolean;
      }
    | { readonly kind: "leave"; readonly key: string }
    | { readonly kind: "group"; readonly group: CopyGroup };

/** Parent versions copy stored relationships without invoking business copy or mutation hooks. */
export class RelationshipCopy {
    constructor(
        private readonly storage: HarnessStorage,
        private readonly trace: PlatformTrace,
        private readonly nextId: () => string,
        private readonly references: ReferenceMaintenance,
        private readonly security: NativeSecurity,
    ) {}

    copy(
        source: StoredItem,
        target: StoredItem,
        copies: Map<string, string>,
        context: ExecutionContext,
    ): void {
        let policy: VersionCopyPolicy | undefined;
        const pending: CopyTask[] = [
            {
                kind: "owner",
                source,
                targetId: target.id,
                depth: 0,
                resetBehavior: isReleased(source),
            },
        ];
        const active = new Set<string>();
        let visited = 0;

        while (pending.length > 0) {
            const task = pending.pop();

            if (!task || ++visited > dataNodesMax || pending.length > dataNodesMax) {
                throw new PlatformError(
                    "ProtocolLimit",
                    "Relationship copies exceed their graph budget.",
                );
            }

            spendContext(context);

            if (task.kind === "leave") {
                active.delete(task.key);
            } else if (task.kind === "owner") {
                this.enter(task, pending, active, context);
            } else {
                policy ??= new VersionCopyPolicy(this.storage);
                this.copyGroup(task.group, copies, pending, policy, context);
            }
        }
    }

    private enter(
        task: Extract<CopyTask, { kind: "owner" }>,
        pending: CopyTask[],
        active: Set<string>,
        context: ExecutionContext,
    ): void {
        const key = recordKey(task.source);

        if (active.has(key) || task.depth > dataDepthMax) {
            throw new PlatformError(
                "RelationshipCycle",
                "Relationship ownership is cyclic or too deep to copy.",
            );
        }

        active.add(key);
        pending.push({ kind: "leave", key });
        const groups = new Map<string, CopyGroup>();

        for (const record of this.references.catalog.owned(task.source, context)) {
            const definition = this.storage.getItemType(record.type);

            if (!definition) {
                throw new PlatformError(
                    "MissingItemType",
                    `Relationship '${record.type}' has no schema.`,
                );
            }

            if (
                definition.isVersionable &&
                this.references.catalog.current(record).id !== record.id
            ) {
                continue;
            }

            const group = groups.get(definition.id) ?? {
                definition,
                records: [],
                parentId: task.targetId,
                depth: task.depth,
                resetBehavior: task.resetBehavior,
            };
            group.records.push(record);
            groups.set(definition.id, group);
        }

        for (const group of [...groups.values()].reverse()) {
            pending.push({ kind: "group", group });
        }
    }

    private copyGroup(
        group: CopyGroup,
        copies: Map<string, string>,
        pending: CopyTask[],
        policy: VersionCopyPolicy,
        context: ExecutionContext,
    ): void {
        policy.assertSupported(group.definition, group.records);
        const records: StoredItem[] = [];

        for (const source of group.records) {
            spendContext(context);
            const copied = this.insert(group, source, context);
            copies.set(relationshipKey(source.type, source.id), copied.id);
            records.push(copied);
        }

        for (let index = records.length - 1; index >= 0; index -= 1) {
            const source = group.records[index];
            const target = records[index];

            if (!source || !target) {
                throw new Error("Each copied relationship must retain its source pairing.");
            }

            pending.push({
                kind: "owner",
                source,
                targetId: target.id,
                depth: group.depth + 1,
                resetBehavior: group.resetBehavior,
            });
        }
    }

    private insert(group: CopyGroup, source: StoredItem, context: ExecutionContext): StoredItem {
        const id = this.nextId();
        const properties = this.references.copied(
            group.definition,
            source,
            group.parentId,
            group.resetBehavior,
        );
        const record: StoredItem = {
            type: group.definition.name,
            id,
            properties: {
                ...properties,
                ...this.security.copied(group.definition, properties, context),
                config_id: id,
                generation: 1,
                is_current: 1,
                new_version:
                    group.definition.isVersionable &&
                    !manualVersioning(this.storage, group.definition)
                        ? 0
                        : 1,
                locked_by_id: null,
            },
        };
        assertActiveContext(context);
        this.storage.insertItem(record);
        this.references.sessions.created(record, context);
        this.trace.record(context, {
            kind: "mutation",
            name: "copy",
            before: source,
            after: record,
        });
        this.references.freeze(source, context);

        return record;
    }
}
