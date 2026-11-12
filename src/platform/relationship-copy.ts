import { assertActiveContext, spendContext } from "../core/context.js";
import { dataDepthMax, dataNodesMax } from "../core/limits.js";
import type { ExecutionContext } from "../core/types.js";
import { Item } from "../items/item.js";
import type { ItemNode } from "../items/item.js";
import type { HarnessStorage, ItemTypeDefinition, StoredItem } from "../storage/types.js";
import { PlatformError } from "./errors.js";
import type { RunEvents } from "./events/types.js";
import { relationshipKey } from "./graph-actions.js";
import type { GraphActions } from "./graph-actions.js";
import { projectItem } from "./projection.js";
import { recordKey } from "./references/catalog.js";
import type { ReferenceMaintenance } from "./references/maintenance.js";
import { isReleased } from "./revisions/policy.js";
import type { NativeSecurity } from "./security/policy.js";
import type { PlatformTrace } from "./trace.js";
import { normalizeProperties } from "./values.js";

interface CopyGroup {
    readonly definition: ItemTypeDefinition;
    readonly records: StoredItem[];
    readonly parentId: string;
    readonly depth: number;
    readonly resetBehavior: boolean;
}

interface CopiedGroup {
    readonly group: CopyGroup;
    readonly requests: readonly ItemNode[];
    readonly records: readonly StoredItem[];
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
    | { readonly kind: "before"; readonly group: CopyGroup }
    | { readonly kind: "after"; readonly copied: CopiedGroup };

const managed = ["config_id", "generation", "is_current", "new_version", "locked_by_id"];

/** Copies preserve source history and create fresh identities under the new owner. */
export class RelationshipCopy {
    constructor(
        private readonly storage: HarnessStorage,
        private readonly trace: PlatformTrace,
        private readonly nextId: () => string,
        private readonly references: ReferenceMaintenance,
        private readonly graph: GraphActions,
        private readonly events: RunEvents,
        private readonly security: NativeSecurity,
    ) {}

    async copy(
        source: StoredItem,
        target: StoredItem,
        copies: Map<string, string>,
        enabled: boolean,
        context: ExecutionContext,
    ): Promise<void> {
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

            if (!task || ++visited > dataNodesMax) {
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
            } else if (task.kind === "before") {
                const copied = await this.before(task.group, copies, enabled, context);
                pending.push({ kind: "after", copied });

                for (let index = copied.records.length - 1; index >= 0; index -= 1) {
                    const source = copied.group.records[index];
                    const target = copied.records[index];

                    if (!source || !target) {
                        throw new Error("Each copied relationship must retain its source pairing.");
                    }

                    pending.push({
                        kind: "owner",
                        source,
                        targetId: target.id,
                        depth: copied.group.depth + 1,
                        resetBehavior: copied.group.resetBehavior,
                    });
                }
            } else {
                await this.after(task.copied, copies, enabled, context);
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
            pending.push({ kind: "before", group });
        }
    }

    private async before(
        group: CopyGroup,
        copies: Map<string, string>,
        enabled: boolean,
        context: ExecutionContext,
    ): Promise<CopiedGroup> {
        if (
            group.definition.isVersionable &&
            group.records.some((record) => String(record.properties.is_released ?? "0") === "1")
        ) {
            throw new PlatformError(
                "UnsupportedRevision",
                "Cloning released relationships requires a revision and lifecycle reset policy.",
            );
        }

        const item = new Item({
            items: group.records.map((record) =>
                projectItem(this.storage, group.definition, record),
            ),
        });
        await this.events(group.definition, "onBeforeCopy", item, enabled, context);

        if (item.payload.items.length !== group.records.length) {
            throw new PlatformError(
                "UnsupportedContextChange",
                "A copy hook cannot change the relationship collection size.",
            );
        }

        const records: StoredItem[] = [];

        for (let index = 0; index < group.records.length; index += 1) {
            const source = group.records[index];
            const request = item.payload.items[index];

            if (!source || !request) {
                throw new Error("A copy request must retain its source record.");
            }

            this.assertRequest(source, request);
            await this.graph.properties(group.definition, request, context);
            const copied = this.insert(group, source, request, context);
            copies.set(relationshipKey(source.type, source.id), copied.id);
            records.push(copied);
        }

        return { group, requests: item.payload.items, records };
    }

    private insert(
        group: CopyGroup,
        source: StoredItem,
        request: ItemNode,
        context: ExecutionContext,
    ): StoredItem {
        const changes = normalizeProperties(this.storage, group.definition, request.properties, {
            creating: false,
            current: source,
        });
        const id = this.nextId();
        const properties = this.references.copied(
            group.definition,
            { ...source, properties: { ...source.properties, ...changes } },
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
                new_version: 1,
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

    private async after(
        copied: CopiedGroup,
        copies: Map<string, string>,
        enabled: boolean,
        context: ExecutionContext,
    ): Promise<void> {
        const items: ItemNode[] = [];

        for (let index = 0; index < copied.records.length; index += 1) {
            const record = copied.records[index];
            const request = copied.requests[index];

            if (!record || !request) {
                throw new Error("Copied records must retain their nested copy requests.");
            }

            const current = this.references.catalog.current(record);
            await this.graph.relationships(
                copied.group.definition,
                request,
                current.id,
                context,
                copies,
            );
            const latest = this.references.catalog.current(record);
            items.push(projectItem(this.storage, copied.group.definition, latest));
        }

        await this.events(
            copied.group.definition,
            "onAfterCopy",
            new Item({ items }),
            enabled,
            context,
        );

        for (let index = 0; index < copied.records.length; index += 1) {
            const record = copied.records[index];
            const source = copied.group.records[index];

            if (!record || !source) {
                throw new Error("Copy results must retain their original identity mapping.");
            }

            copies.set(
                relationshipKey(source.type, source.id),
                this.references.catalog.current(record).id,
            );
        }
    }

    private assertRequest(source: StoredItem, request: ItemNode): void {
        if (
            request.type.toLowerCase() !== source.type.toLowerCase() ||
            request.attributes.id !== source.id ||
            (request.logical?.length ?? 0) > 0
        ) {
            throw new PlatformError(
                "UnsupportedContextChange",
                "A copy hook cannot change source identities or add query criteria.",
            );
        }

        for (const name of managed) {
            const value = request.properties[name];

            if (
                value !== undefined &&
                String(value ?? "") !== String(source.properties[name] ?? "")
            ) {
                throw new PlatformError(
                    "ReadOnlyProperty",
                    `Copy property '${source.type}.${name}' is managed by the platform.`,
                );
            }
        }
    }
}
