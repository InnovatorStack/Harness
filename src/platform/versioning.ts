import { assertActiveContext } from "../core/context.js";
import { getOwn } from "../core/data.js";
import type { ExecutionContext } from "../core/types.js";
import { Item } from "../items/item.js";
import type {
    HarnessStorage,
    ItemTypeDefinition,
    StorageValue,
    StoredItem,
} from "../storage/types.js";
import { ApplicationError, PlatformError } from "./errors.js";
import type { EventRunners } from "./events/types.js";
import type { GraphActions } from "./graph-actions.js";
import type { ClassificationChange, LifeCycles } from "./lifecycle.js";
import type { ItemLocks } from "./locks.js";
import { projectItem } from "./projection.js";
import type { DependentDeletion } from "./references/deletion.js";
import type { ReferenceMaintenance } from "./references/maintenance.js";
import { RelationshipCopy } from "./relationship-copy.js";
import { validateRequest } from "./request.js";
import { isReleased, removeRevisionProperties } from "./revisions/policy.js";
import type { Revisions } from "./revisions/policy.js";
import type { NativeSecurity } from "./security/policy.js";
import type { PlatformTrace } from "./trace.js";
import { normalizeProperties } from "./values.js";
import { manualVersioning } from "./version-policy.js";

const managedProperties = ["config_id", "generation", "is_current", "new_version", "locked_by_id"];

interface PreparedUpdate {
    readonly record: StoredItem;
    readonly request: Item;
    readonly copies: Map<string, string>;
    readonly versioned: boolean;
    readonly enabled: boolean;
    readonly select: string | undefined;
}

interface GenerationWrite {
    readonly after: StoredItem;
    readonly classification: ClassificationChange | undefined;
}

interface BatchResult {
    readonly response: Item;
    readonly targets: readonly StoredItem[];
}

/** Owns generation creation; business events continue through the ordinary Method pipeline. */
export class Versioning {
    private readonly copier: RelationshipCopy;

    constructor(
        private readonly storage: HarnessStorage,
        private readonly trace: PlatformTrace,
        private readonly locks: ItemLocks,
        private readonly runners: EventRunners,
        private readonly nextId: () => string,
        private readonly graph: GraphActions,
        private readonly references: ReferenceMaintenance,
        private readonly deletion: DependentDeletion,
        private readonly revisions: Revisions,
        private readonly lifeCycles: LifeCycles,
        private readonly security: NativeSecurity,
    ) {
        this.copier = new RelationshipCopy(
            storage,
            trace,
            nextId,
            references,
            graph,
            runners.collection,
            security,
        );
    }

    assertCurrent(record: StoredItem): void {
        const configId = record.properties.config_id;
        const generation = Number(record.properties.generation);
        const family = this.family(record);
        const current = family.filter((item) => String(item.properties.is_current) === "1");

        if (
            typeof configId !== "string" ||
            !configId ||
            !Number.isSafeInteger(generation) ||
            generation < 1 ||
            current.length !== 1 ||
            current[0]?.id !== record.id ||
            family.some(
                (item) =>
                    !Number.isSafeInteger(Number(item.properties.generation)) ||
                    Number(item.properties.generation) < 1 ||
                    Number(item.properties.generation) > generation,
            ) ||
            new Set(family.map((item) => Number(item.properties.generation))).size !== family.length
        ) {
            throw new PlatformError(
                "InvalidGeneration",
                `Mutation requires the single current generation of '${record.type}:${record.id}'. Fetch it by config_id and is_current=1.`,
            );
        }
    }

    family(record: StoredItem): readonly StoredItem[] {
        return this.references.catalog.family(record);
    }

    async applyBatch(
        definition: ItemTypeDefinition,
        records: readonly StoredItem[],
        request: Item,
        context: ExecutionContext,
    ): Promise<Item> {
        const targets = await this.prepareTargets(definition, records, request, context);
        const result =
            request.getAction() === "version"
                ? await this.versionBatch(definition, targets, request, context)
                : await this.updateBatch(definition, targets, request, context);

        if (request.getAction() === "edit") {
            for (const record of result.targets) {
                await this.unlockAfterEdit(definition, record.id, result.response, context);
            }
        }

        return result.response;
    }

    private async prepareTargets(
        definition: ItemTypeDefinition,
        records: readonly StoredItem[],
        request: Item,
        context: ExecutionContext,
    ): Promise<readonly StoredItem[]> {
        const ordered = this.orderedTargets(records, request);
        this.authorizeTargets(definition, ordered, request.getAction(), context);
        const targets: StoredItem[] = [];

        for (const record of ordered) {
            targets.push(
                await this.lockForUpdate(
                    definition,
                    this.currentRecord(record),
                    request.getAction(),
                    context,
                ),
            );
        }

        this.authorizeTargets(definition, targets, request.getAction(), context);

        return targets.map((record) => this.currentRecord(record));
    }

    private orderedTargets(records: readonly StoredItem[], request: Item): readonly StoredItem[] {
        const selector = request.getAttribute("idlist");

        if (!selector || request.getID()) {
            return records;
        }

        const ids = selector.split(",").map((id) => id.trim().toLowerCase());

        if (new Set(ids).size !== ids.length) {
            throw new PlatformError(
                "InvalidSelector",
                "Versioned actions require unique idlist IDs.",
            );
        }

        const available = new Map(records.map((record) => [record.id.toLowerCase(), record]));

        return ids.flatMap((id) => {
            const record = available.get(id);

            return record ? [record] : [];
        });
    }

    private authorizeTargets(
        definition: ItemTypeDefinition,
        records: readonly StoredItem[],
        action: string,
        context: ExecutionContext,
    ): void {
        for (const record of records) {
            const current = this.currentRecord(record);
            this.security.assertMutation(definition, current, action, context);
            this.assertCurrent(current);
        }
    }

    private async updateBatch(
        definition: ItemTypeDefinition,
        records: readonly StoredItem[],
        request: Item,
        context: ExecutionContext,
    ): Promise<BatchResult> {
        const result: Item["node"][] = [];
        const enabled = request.getAttribute("serverEvents") !== "0";

        for (const record of records) {
            const prepared = this.updateRequest(record, request, false);
            await this.beforeUpdate(definition, prepared, context);

            if (this.shouldVersion(definition, record, prepared.request)) {
                // Native update restarts the selected batch from its original request.
                return await this.versionBatch(definition, records, request, context);
            }

            this.assertUnreleased(definition, record);
            const response = await this.updateGeneration(definition, prepared, context);
            result.push(...response.payload.items);
        }

        return {
            response: await this.afterUpdates(definition, result, enabled, context),
            targets: records,
        };
    }

    private async versionBatch(
        definition: ItemTypeDefinition,
        records: readonly StoredItem[],
        request: Item,
        context: ExecutionContext,
    ): Promise<BatchResult> {
        this.authorizeTargets(definition, records, "version", context);
        const sources = records.map((record) => this.currentRecord(record));
        const update = await this.beforeVersions(definition, sources, request, context);
        const prepared: PreparedUpdate[] = [];
        const oldIds = sources.map((source) => source.id).join(",");

        for (const source of sources) {
            const record = this.create(definition, source, context);
            const target = this.updateRequest(record, update, true);
            target.request.setAttribute("oldId", oldIds);

            if (isReleased(source)) {
                removeRevisionProperties(target.request, source, record);
            }

            prepared.push(target);
        }

        await this.locks.unlockVersionSources(definition, sources, context);
        await this.finishVersions(definition, sources, prepared, context);
        const updates = prepared.map((target) => ({
            ...target,
            record: this.currentRecord(target.record),
        }));
        const targets = updates.map((target) => target.record);
        this.authorizeTargets(definition, targets, "update", context);
        const result: Item["node"][] = [];

        for (const target of updates) {
            await this.beforeUpdate(definition, target, context);
            const response = await this.updateGeneration(definition, target, context);
            result.push(...response.payload.items);
        }

        return {
            response: await this.afterUpdates(
                definition,
                result,
                update.getAttribute("serverEvents") !== "0",
                context,
            ),
            targets,
        };
    }

    private async beforeVersions(
        definition: ItemTypeDefinition,
        records: readonly StoredItem[],
        request: Item,
        context: ExecutionContext,
    ): Promise<Item> {
        for (const record of records) {
            assertActiveContext(context);
            this.storage.updateItem(definition.name, record.id, {
                is_current: 0,
                ...(record.properties.locked_by_id === undefined ? { locked_by_id: null } : {}),
            });
        }

        const update = request.clone();
        update.setAction("version");
        delete update.node.attributes.where;
        delete update.node.attributes.idlist;

        for (const record of records) {
            update.setProperty("id", record.id);
            this.removeManagedProperties(update, record);
            await this.runners.item(definition, "onBeforeVersion", update, true, context);

            if (
                update.getID() !== record.id ||
                update.getType() !== definition.name ||
                update.getAction() !== "version"
            ) {
                throw new PlatformError(
                    "UnsupportedContextChange",
                    "A version event cannot change the source generation, ItemType or action.",
                );
            }

            this.removeManagedProperties(update, record);
        }

        return update;
    }

    private async afterUpdates(
        definition: ItemTypeDefinition,
        nodes: readonly Item["node"][],
        enabled: boolean,
        context: ExecutionContext,
    ): Promise<Item> {
        const results: Item["node"][] = [];

        for (const node of nodes) {
            const item = new Item({ items: [node] });
            await this.runners.item(definition, "onAfterUpdate", item, enabled, context);
            results.push(...item.payload.items);
        }

        const response = new Item({ items: results });
        await this.runners.collection(definition, "onAfterUpdate", response, enabled, context);

        return response;
    }

    private updateRequest(record: StoredItem, request: Item, versioned: boolean): PreparedUpdate {
        const update = request.clone();
        update.setProperty("id", record.id);
        delete update.node.attributes.where;
        delete update.node.attributes.idlist;

        return {
            record,
            request: update,
            copies: new Map<string, string>(),
            versioned,
            enabled: request.getAttribute("serverEvents") !== "0",
            select: request.node.attributes.select,
        };
    }

    private async beforeUpdate(
        definition: ItemTypeDefinition,
        prepared: PreparedUpdate,
        context: ExecutionContext,
    ): Promise<void> {
        const { request, record, enabled } = prepared;
        const action = request.getAction();
        this.removeManagedProperties(request, record, prepared.versioned);

        if (prepared.versioned && !manualVersioning(this.storage, definition)) {
            request.setProperty("new_version", 1);
        }

        await this.runners.item(definition, "onBeforeUpdate", request, enabled, context);
        const attributes = { ...request.node.attributes };
        delete attributes.oldId;
        validateRequest({ ...request.node, attributes }, "update");

        if (
            request.getType() !== definition.name ||
            request.getAction() !== action ||
            request.getID() !== record.id
        ) {
            throw new PlatformError(
                "UnsupportedContextChange",
                "An update event cannot change the target generation, ItemType or action.",
            );
        }

        this.removeManagedProperties(request, record, prepared.versioned);
        const current = this.currentRecord(record);
        this.locks.assertOwned(current);
        this.lifeCycles.classificationChange(definition, record, request.node.properties, context);
    }

    private assertUnreleased(definition: ItemTypeDefinition, record: StoredItem): void {
        if (isReleased(record)) {
            throw new ApplicationError(
                Item.error(
                    `Released '${definition.name}' requires a new revision before it can be changed.`,
                    "ReleasedItem",
                ),
            );
        }
    }

    private async lockForUpdate(
        definition: ItemTypeDefinition,
        record: StoredItem,
        action: string,
        context: ExecutionContext,
    ): Promise<StoredItem> {
        if (action === "edit") {
            const locked = await this.locks.apply(definition, record, "lock", context);
            this.locks.assertOwned(locked);

            return locked;
        }

        if (action === "version") {
            this.locks.assertAvailable(record);
        }

        return record;
    }

    private shouldVersion(
        definition: ItemTypeDefinition,
        record: StoredItem,
        request: Item,
    ): boolean {
        const manual = manualVersioning(this.storage, definition);

        return (
            !manual &&
            request.getAttribute("version", "1") === "1" &&
            String(record.properties.new_version ?? "0") !== "1"
        );
    }

    private currentRecord(record: StoredItem): StoredItem {
        const current = this.storage.getItem(record.type, record.id);

        if (!current) {
            throw new PlatformError(
                "MissingItem",
                `Action target '${record.type}:${record.id}' disappeared.`,
            );
        }

        return current;
    }

    private async unlockAfterEdit(
        definition: ItemTypeDefinition,
        id: string,
        response: Item,
        context: ExecutionContext,
    ): Promise<void> {
        const latest = this.storage.getItem(definition.name, id);

        if (!latest) {
            throw new PlatformError("MissingItem", "Updated generation disappeared before unlock.");
        }

        const unlocked = await this.locks.apply(definition, latest, "unlock", context);

        for (const node of response.payload.items) {
            if (
                node.type.toLowerCase() !== definition.name.toLowerCase() ||
                node.attributes.id?.toLowerCase() !== id.toLowerCase()
            ) {
                continue;
            }

            if (node.properties.locked_by_id !== undefined) {
                node.properties.locked_by_id = unlocked.properties.locked_by_id ?? null;
            }

            if (node.properties.new_version !== undefined) {
                node.properties.new_version = unlocked.properties.new_version ?? null;
            }
        }
    }

    private async updateGeneration(
        definition: ItemTypeDefinition,
        prepared: PreparedUpdate,
        context: ExecutionContext,
    ): Promise<Item> {
        const { request: update, select, enabled, copies } = prepared;
        const record = this.currentRecord(prepared.record);

        this.revisions.assertValue(definition, update.node.properties.major_rev);
        const locked = this.storage.getItem(definition.name, record.id);

        if (!locked) {
            throw new PlatformError(
                "MissingItem",
                "The target generation disappeared in an update event.",
            );
        }

        this.locks.assertOwned(locked);
        await this.graph.properties(definition, update.node, context);
        const written = this.writeGeneration(definition, locked, prepared, context);
        let after = written.after;
        await this.deletion.changed(record, after, enabled, context);
        const children = await this.graph.relationships(
            definition,
            update.node,
            record.id,
            context,
            copies,
        );
        after = this.lifeCycles.applyClassification(after, written.classification, context);
        const response = new Item({
            items: [
                {
                    ...projectItem(this.storage, definition, after, select),
                    relationships: children,
                },
            ],
        });
        this.security.changed(locked, after, context);

        return response;
    }

    private writeGeneration(
        definition: ItemTypeDefinition,
        record: StoredItem,
        prepared: PreparedUpdate,
        context: ExecutionContext,
    ): GenerationWrite {
        const values = normalizeProperties(
            this.storage,
            definition,
            prepared.request.node.properties,
            {
                creating: false,
                current: record,
            },
        );
        const classification = this.lifeCycles.classificationChange(
            definition,
            record,
            values,
            context,
            prepared.record,
        );
        const authorized = this.lifeCycles.authorizeUpdate(
            definition,
            record,
            values,
            classification,
            context,
        );

        if (prepared.versioned && !manualVersioning(this.storage, definition)) {
            authorized.new_version = 1;
        }

        assertActiveContext(context);
        this.storage.updateItem(
            definition.name,
            record.id,
            this.security.auditedChanges(record, authorized),
        );
        const after = this.storage.getItem(definition.name, record.id);

        if (!after) {
            throw new PlatformError("MissingItem", "Updated generation disappeared.");
        }

        this.trace.record(context, { kind: "mutation", name: "update", before: record, after });

        return { after, classification };
    }

    private removeManagedProperties(request: Item, record: StoredItem, versioned = false): void {
        for (const name of managedProperties) {
            const value = getOwn(request.node.properties, name);

            if (value === undefined) {
                continue;
            }

            const expected = name === "new_version" && versioned ? 1 : record.properties[name];

            if (String(value ?? "") !== String(expected ?? "")) {
                throw new PlatformError(
                    "ReadOnlyProperty",
                    `Version property '${record.type}.${name}' is managed by platform actions.`,
                );
            }

            delete request.node.properties[name];
        }
    }

    private create(
        definition: ItemTypeDefinition,
        previous: StoredItem,
        context: ExecutionContext,
    ): StoredItem {
        const id = this.nextId();
        const after: StoredItem = {
            id,
            type: definition.name,
            properties: this.generationProperties(definition, previous),
        };
        this.revisions.assertValue(definition, after.properties.major_rev);
        assertActiveContext(context);
        this.storage.insertItem(after);
        this.trace.record(context, { kind: "mutation", name: "version", before: previous, after });

        return after;
    }

    private generationProperties(
        definition: ItemTypeDefinition,
        previous: StoredItem,
    ): Record<string, StorageValue> {
        const defaultMarker = manualVersioning(this.storage, definition) ? 1 : 0;

        return {
            ...previous.properties,
            ...this.revisionProperties(definition, previous),
            config_id: previous.properties.config_id ?? previous.id,
            generation: this.nextGeneration(previous),
            is_current: 1,
            new_version: previous.properties.new_version ?? defaultMarker,
            locked_by_id: this.locks.owner(),
        };
    }

    private revisionProperties(definition: ItemTypeDefinition, previous: StoredItem) {
        if (!isReleased(previous)) {
            return {};
        }

        return {
            major_rev: this.revisions.next(definition, previous),
            ...this.lifeCycles.revisionProperties(definition, previous),
        };
    }

    private async finishVersions(
        definition: ItemTypeDefinition,
        sources: readonly StoredItem[],
        targets: readonly PreparedUpdate[],
        context: ExecutionContext,
    ): Promise<void> {
        for (const [index, target] of targets.entries()) {
            const previous = sources[index];

            if (!previous) {
                throw new PlatformError("InvalidGeneration", "A version source is missing.");
            }

            await this.copier.copy(previous, target.record, target.copies, target.enabled, context);
            this.references.versioned(previous, target.record, context);
            this.security.changed(previous, this.currentRecord(target.record), context);
        }

        for (const target of targets) {
            const item = new Item({
                items: [projectItem(this.storage, definition, this.currentRecord(target.record))],
            });
            await this.runners.item(definition, "onAfterVersion", item, true, context);
        }

        const result = new Item({
            items: targets.map((target) =>
                projectItem(this.storage, definition, this.currentRecord(target.record)),
            ),
        });
        await this.runners.collection(definition, "onAfterVersion", result, true, context);
    }

    private nextGeneration(record: StoredItem): number {
        const generation = Number(record.properties.generation);

        if (
            !Number.isSafeInteger(generation) ||
            generation < 1 ||
            generation >= Number.MAX_SAFE_INTEGER
        ) {
            throw new PlatformError(
                "InvalidGeneration",
                "The generation counter cannot advance safely.",
            );
        }

        return generation + 1;
    }
}
