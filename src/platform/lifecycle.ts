import { assertActiveContext, spendContext } from "../core/context.js";
import { getOwn } from "../core/data.js";
import type { ExecutionContext } from "../core/types.js";
import { Item } from "../items/item.js";
import type {
    CatalogEntry,
    HarnessStorage,
    ItemTypeDefinition,
    StorageValue,
    StoredItem,
} from "../storage/types.js";
import type { Classifications } from "./classifications.js";
import { ApplicationError, PlatformError, requireSuccess } from "./errors.js";
import type { RunEvents } from "./events/types.js";
import { projectItem } from "./projection.js";
import type { ReferenceMaintenance } from "./references/maintenance.js";
import type { NativeSecurity } from "./security/policy.js";
import type { PlatformTrace } from "./trace.js";

interface Lifecycle {
    readonly map: CatalogEntry;
    readonly states: readonly CatalogEntry[];
}

export interface ClassificationChange {
    readonly changed: boolean;
    readonly properties?: Readonly<Record<string, StorageValue>>;
}

export class LifeCycles {
    constructor(
        private readonly storage: HarnessStorage,
        private readonly trace: PlatformTrace,
        private readonly events: RunEvents,
        private readonly callMethod: (
            name: string,
            item: Item,
            context: ExecutionContext,
        ) => Promise<Item>,
        private readonly references: ReferenceMaintenance,
        private readonly security: NativeSecurity,
        private readonly classifications: Classifications,
    ) {}

    classificationChange(
        definition: ItemTypeDefinition,
        record: StoredItem,
        values: Readonly<Record<string, StorageValue>>,
        context: ExecutionContext,
        previous = record,
    ): ClassificationChange | undefined {
        const classification = values.classification;

        if (classification === undefined) {
            return undefined;
        }

        this.classifications.assertValue(definition, classification, context);
        const target = this.resolve(definition, classification);
        const before = this.currentLifecycle(previous);
        const current = previous === record ? before : this.currentLifecycle(record);
        const changed =
            String(previous.properties.classification ?? "") !== String(classification ?? "");
        const mapChanged = before?.id !== target?.map.id;

        if (
            mapChanged &&
            before &&
            before.properties.start_state !== previous.properties.current_state
        ) {
            throw new ApplicationError(
                Item.error(
                    `Cannot change '${definition.name}' to class '${classification ?? ""}' outside its lifecycle start state.`,
                    "ClassificationCannotBeChanged",
                ),
            );
        }

        const reset = current?.id !== target?.map.id;

        if (changed || mapChanged || reset) {
            this.security.assertCanReclassify(definition, String(classification ?? ""), context);
        }

        if (!reset) {
            return { changed };
        }

        const properties = target
            ? this.initialProperties(definition, classification)
            : { state: null, current_state: null, is_released: 0, not_lockable: 0 };

        return { changed, properties };
    }

    applyClassification(
        record: StoredItem,
        change: ClassificationChange | undefined,
        context: ExecutionContext,
    ): StoredItem {
        if (!change?.properties) {
            return record;
        }

        assertActiveContext(context);
        this.storage.updateItem(record.type, record.id, change.properties);
        const after = this.storage.getItem(record.type, record.id);

        if (!after) {
            throw new PlatformError("MissingItem", "The lifecycle reset target disappeared.");
        }

        this.trace.record(context, {
            kind: "mutation",
            name: "set-default-lifecycle",
            before: record,
            after,
        });
        this.references.promoted(after, context);

        return after;
    }

    authorizeUpdate(
        definition: ItemTypeDefinition,
        record: StoredItem,
        values: Record<string, StorageValue>,
        classification: ClassificationChange | undefined,
        context: ExecutionContext,
    ): Record<string, StorageValue> {
        const permission = classification?.properties?.permission_id;
        const requested = { ...values };

        if (permission !== undefined) {
            delete requested.permission_id;

            if (!classification?.changed && permission !== record.properties.permission_id) {
                this.security.assertPermissionChange(definition, record, context);
            }
        }

        this.security.assertAccessChange(
            definition,
            record,
            requested,
            context,
            classification?.changed,
        );

        return permission === undefined ? values : { ...values, permission_id: permission };
    }

    private currentLifecycle(record: StoredItem): CatalogEntry | undefined {
        const id = record.properties.current_state;

        if (id === undefined || id === null || id === "") {
            return undefined;
        }

        const state = this.storage.getCatalogEntry("Life Cycle State", String(id));
        const map = state
            ? this.storage.getCatalogEntry("Life Cycle Map", String(state.properties.source_id))
            : undefined;

        if (!map) {
            throw new PlatformError(
                "InvalidLifeCycleState",
                `Import the lifecycle of '${record.type}:${record.id}' before changing its classification.`,
            );
        }

        return map;
    }

    initialProperties(
        definition: ItemTypeDefinition,
        classification: StorageValue | undefined,
    ): Readonly<Record<string, StorageValue>> {
        const lifecycle = this.resolve(definition, classification);

        if (!lifecycle) {
            return {};
        }

        return this.startProperties(lifecycle);
    }

    /** Native copy starts each type's default lifecycle after the entire owned graph exists. */
    resetCopies(records: readonly StoredItem[], context: ExecutionContext): void {
        const groups = new Map<string, StoredItem[]>();

        for (const record of records) {
            const group = groups.get(record.type) ?? [];
            group.push(record);
            groups.set(record.type, group);
        }

        for (const [type, group] of groups) {
            const definition = this.storage.getItemType(type);

            if (!definition) {
                throw new Error("Copied records must retain their imported ItemType.");
            }

            for (const record of group) {
                spendContext(context);
                this.resetCopy(definition, record.id, context);
            }
        }
    }

    private resetCopy(definition: ItemTypeDefinition, id: string, context: ExecutionContext): void {
        const before = this.storage.getItem(definition.name, id);

        if (!before) {
            throw new Error("Lifecycle initialization requires its copied record.");
        }

        const lifecycle = this.resolve(definition, before.properties.classification);
        const values = lifecycle
            ? this.startProperties(lifecycle)
            : { state: null, current_state: null, is_released: 0, not_lockable: 0 };

        if (definition.isVersionable && values.is_released === 1) {
            throw new PlatformError(
                "UnsupportedRevision",
                `Copying '${definition.name}' into a released start state requires release-date initialization, which is unavailable.`,
                definition.source ? { source: definition.source } : undefined,
            );
        }

        assertActiveContext(context);
        this.storage.updateItem(definition.name, id, this.security.auditedChanges(before, values));
        const after = this.storage.getItem(definition.name, id);

        if (!after) {
            throw new Error("Lifecycle initialization must retain its copied record.");
        }

        this.trace.record(context, { kind: "mutation", name: "reset-lifecycle", before, after });
        this.security.changed(before, after, context);
        this.references.promoted(after, context);
    }

    private startProperties(lifecycle: Lifecycle): Readonly<Record<string, StorageValue>> {
        const start = lifecycle.states.find(
            (state) => state.id === lifecycle.map.properties.start_state,
        );

        if (!start) {
            throw new PlatformError(
                "InvalidLifeCycle",
                `Life Cycle Map '${lifecycle.map.id}' has no imported start state.`,
                { source: lifecycle.map.source },
            );
        }

        this.assertStateExecution(start);

        return this.stateProperties(start);
    }

    revisionProperties(
        definition: ItemTypeDefinition,
        record: StoredItem,
    ): Readonly<Record<string, StorageValue>> {
        const map = this.currentLifecycle(record);

        if (!map) {
            throw new PlatformError(
                "MissingLifeCycle",
                `Import a Life Cycle Map before revising released '${definition.name}'.`,
                definition.source ? { source: definition.source } : undefined,
            );
        }

        const lifecycle = {
            map,
            states: this.storage
                .listCatalogEntries("Life Cycle State")
                .filter((state) => state.properties.source_id === map.id),
        };
        const current = lifecycle.states.find(
            (state) => state.id === record.properties.current_state,
        );

        if (!current || current.properties.name !== record.properties.state) {
            throw new PlatformError(
                "InvalidLifeCycleState",
                `Revising '${definition.name}' requires its current state and imported Life Cycle Map.`,
                definition.source ? { source: definition.source } : undefined,
            );
        }

        const initial = this.startProperties(lifecycle);

        if (typeof initial.current_state !== "string" || initial.current_state.length === 0) {
            throw new PlatformError(
                "MissingLifeCycle",
                `Import a Life Cycle Map for the new revision of '${definition.name}'.`,
                definition.source ? { source: definition.source } : undefined,
            );
        }

        return { ...initial, release_date: null, effective_date: null, superseded_date: null };
    }

    seedProperties(
        definition: ItemTypeDefinition,
        values: Readonly<Record<string, StorageValue>>,
    ): Readonly<Record<string, StorageValue>> {
        const lifecycle = this.resolve(definition, values.classification);

        if (!lifecycle) {
            return values;
        }

        const name = String(values.state ?? "");
        const id =
            String(values.current_state ?? "") ||
            (name ? undefined : lifecycle.map.properties.start_state);
        const matches = lifecycle.states.filter(
            (state) =>
                (!name || state.properties.name === name) && (!Boolean(id) || state.id === id),
        );
        const state = matches[0];

        if (matches.length !== 1 || !state) {
            throw new PlatformError(
                "InvalidLifeCycleState",
                `Fixture '${definition.name}' needs a state from its imported lifecycle; state and current_state must agree.`,
            );
        }

        const defaults = this.stateProperties(state);

        return { ...defaults, ...values, state: defaults.state, current_state: state.id };
    }

    async promote(
        definition: ItemTypeDefinition,
        record: StoredItem,
        request: Item,
        context: ExecutionContext,
        authorize: (transition: CatalogEntry) => Promise<void>,
    ): Promise<Item> {
        const { target, transition } = this.promotionTarget(definition, record, request);
        await authorize(transition);
        const enabled = request.getAttribute("serverEvents") !== "0";
        const before = new Item({ items: [projectItem(this.storage, definition, record)] });
        await this.events(definition, "onBeforePromote", before, enabled, context);
        await this.transitionMethod(transition, "pre_action", before, context);

        assertActiveContext(context);

        this.storage.updateItem(definition.name, record.id, this.stateProperties(target));
        const after = this.storage.getItem(definition.name, record.id);

        if (!after) {
            throw new PlatformError("MissingItem", "Promoted record disappeared.");
        }

        this.trace.record(context, {
            kind: "mutation",
            name: "promote",
            before: record,
            after,
            source: transition.source,
        });
        this.security.changed(record, after, context);
        this.references.promoted(after, context);
        const result = new Item({
            items: [projectItem(this.storage, definition, after, request.node.attributes.select)],
        });
        await this.events(definition, "onAfterPromote", result, enabled, context);
        await this.transitionMethod(transition, "post_action", result, context);

        return result;
    }

    private promotionTarget(
        definition: ItemTypeDefinition,
        record: StoredItem,
        request: Item,
    ): { target: CatalogEntry; transition: CatalogEntry } {
        const lifecycle = this.resolve(definition, record.properties.classification);

        if (!lifecycle) {
            throw new PlatformError(
                "MissingLifeCycle",
                `No Life Cycle Map is imported for '${definition.name}'.`,
            );
        }

        const current = lifecycle.states.find(
            (state) => state.id === record.properties.current_state,
        );

        if (!current || current.properties.name !== record.properties.state) {
            throw new PlatformError(
                "InvalidLifeCycleState",
                `Record '${record.type}:${record.id}' needs consistent state and current_state values from its imported lifecycle.`,
            );
        }

        const target = lifecycle.states.find(
            (state) => state.properties.name === request.getProperty("state"),
        );
        const candidates = this.storage
            .listCatalogEntries("Life Cycle Transition")
            .filter(
                (transition) =>
                    transition.properties.source_id === lifecycle.map.id &&
                    transition.properties.from_state === current.id &&
                    transition.properties.to_state === target?.id,
            );
        const transition = candidates[0];

        if (!target || candidates.length !== 1 || !transition) {
            throw new PlatformError(
                "InvalidLifeCycleTransition",
                `Expected one transition from '${current.properties.name}' ` +
                    `to '${request.getProperty("state")}' in '${lifecycle.map.properties.name}'; ` +
                    `found ${candidates.length}.`,
            );
        }

        if (
            Boolean(transition.properties.post_action) &&
            String(transition.properties.execute_post_in_main_txn ?? "0") !== "1"
        ) {
            throw new PlatformError(
                "UnsupportedPostTransactionMethod",
                `Transition '${transition.id}' has a post Method outside the main transaction. This execution profile supports transactional transition Methods only.`,
                { source: transition.source },
            );
        }

        this.assertStateExecution(target);

        return { target, transition };
    }

    private assertStateExecution(state: CatalogEntry): void {
        if (Boolean(state.properties.workflow)) {
            throw new PlatformError(
                "UnsupportedWorkflow",
                `State '${state.properties.name}' starts a workflow, which needs a workflow adapter.`,
                { source: state.source },
            );
        }
    }

    private async transitionMethod(
        transition: CatalogEntry,
        property: string,
        item: Item,
        context: ExecutionContext,
    ): Promise<void> {
        const method = getOwn(transition.properties, property);

        if (typeof method !== "string" || !method) {
            return;
        }

        this.trace.record(context, { kind: "event", name: property, source: transition.source });
        const event = item.clone();
        event.setAttribute("transition_id", transition.id);
        event.setAttribute("from_state", String(transition.properties.from_state));
        event.setAttribute("to_state", String(transition.properties.to_state));
        requireSuccess(await this.callMethod(method, event, context));
    }

    private stateProperties(state: CatalogEntry) {
        if (typeof state.properties.name !== "string") {
            throw new PlatformError(
                "InvalidLifeCycleState",
                `Life Cycle State '${state.id}' has no name.`,
            );
        }

        return {
            state: state.properties.name,
            current_state: state.id,
            is_released: Number(state.properties.set_is_released ?? "0"),
            not_lockable: Number(state.properties.set_not_lockable ?? "0"),
            ...(Boolean(state.properties.state_permission_id)
                ? { permission_id: state.properties.state_permission_id }
                : {}),
        };
    }

    private resolve(
        definition: ItemTypeDefinition,
        classification: StorageValue | undefined,
    ): Lifecycle | undefined {
        const path = String(classification ?? "");
        const bindings = this.storage
            .listCatalogEntries("ItemType Life Cycle")
            .filter((binding) => {
                const classPath = String(binding.properties.class_path ?? "");

                return (
                    binding.properties.source_id === definition.id &&
                    (!classPath || path === classPath || path.startsWith(`${classPath}/`))
                );
            })
            .sort(
                (left, right) =>
                    String(right.properties.class_path ?? "").length -
                    String(left.properties.class_path ?? "").length,
            );
        const binding = bindings[0];

        if (!binding) {
            return undefined;
        }

        if (
            bindings[1] &&
            String(bindings[1].properties.class_path ?? "") ===
                String(binding.properties.class_path ?? "")
        ) {
            throw new PlatformError(
                "AmbiguousLifeCycle",
                `Multiple Life Cycle Maps match '${definition.name}' classification '${path}'.`,
            );
        }

        const map = this.storage.getCatalogEntry(
            "Life Cycle Map",
            String(binding.properties.related_id),
        );

        if (!map) {
            throw new PlatformError(
                "MissingLifeCycle",
                `Import Life Cycle Map '${binding.properties.related_id}' for '${definition.name}'.`,
            );
        }

        return {
            map,
            states: this.storage
                .listCatalogEntries("Life Cycle State")
                .filter((state) => state.properties.source_id === map.id),
        };
    }
}
