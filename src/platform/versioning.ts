import { assertActiveContext } from "../core/context.js";
import { getOwn } from "../core/data.js";
import type { ExecutionContext } from "../core/types.js";
import { Item } from "../items/item.js";
import { MethodEventDataKind } from "../methods/event-data.js";
import type {
    HarnessStorage,
    ItemTypeDefinition,
    StorageValue,
    StoredItem,
} from "../storage/types.js";
import { ApplicationError, PlatformError } from "./errors.js";
import { afterUpdateFrames, afterVersionFrames } from "./events/data.js";
import type { EventRunners, UpdateResult } from "./events/types.js";
import type { GraphActions } from "./graph-actions.js";
import type { ClassificationChange, LifeCycles } from "./lifecycle.js";
import type { ItemLocks } from "./locks.js";
import { projectItem } from "./projection.js";
import type { DependentDeletion } from "./references/deletion.js";
import type { ReferenceMaintenance } from "./references/maintenance.js";
import { RelationshipCopy } from "./relationship-copy.js";
import { rememberRequestCopies } from "./request-copies.js";
import { validateRequest } from "./request.js";
import { isReleased } from "./revisions/policy.js";
import type { Revisions } from "./revisions/policy.js";
import type { NativeSecurity } from "./security/policy.js";
import type { PlatformTrace } from "./trace.js";
import { normalizeProperties } from "./values.js";
import { manualVersioning } from "./version-policy.js";
import {
    remapVersionRelationships,
    versionCriteria,
    versionedRequest,
} from "./versioned-request.js";

const managedProperties = ["config_id", "generation", "is_current", "new_version", "locked_by_id"];

interface PreparedVersion {
    readonly record: StoredItem;
    readonly copies: Map<string, string>;
}

interface PreparedUpdate extends PreparedVersion {
    readonly request: Item;
    readonly versioned: boolean;
    readonly enabled: boolean;
    readonly select: string | undefined;
    readonly idList: readonly string[];
}

interface GenerationWrite {
    readonly after: StoredItem;
    readonly classification: ClassificationChange | undefined;
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
            security,
            lifeCycles,
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
    ): Promise<UpdateResult> {
        const targets = this.orderedTargets(records, request);

        if (request.getAction() === "version") {
            const prepared = await this.prepareTargets(definition, targets, request, context);

            return await this.versionBatch(definition, prepared, request, context);
        }

        if (request.getAction() === "edit") {
            return await this.editBatch(definition, targets, request, context);
        }

        return {
            response: await this.updateEvent(definition, targets, request, context),
            completed: true,
        };
    }

    private async updateEvent(
        definition: ItemTypeDefinition,
        records: readonly StoredItem[],
        request: Item,
        context: ExecutionContext,
    ): Promise<Item> {
        return await this.runners.update(definition, request, context, async (pending, nested) => {
            const targets = records.map((record) => this.currentRecord(record));
            this.authorizeTargets(definition, targets, "update", nested);

            try {
                return await this.updateBatch(definition, targets, pending, nested);
            } finally {
                request.payload.items = pending.payload.items;
            }
        });
    }

    private async editBatch(
        definition: ItemTypeDefinition,
        records: readonly StoredItem[],
        request: Item,
        context: ExecutionContext,
    ): Promise<UpdateResult> {
        const pending = request.clone();
        pending.setAttribute("doGetItem", "0");
        const targets = await this.prepareTargets(definition, records, pending, context);
        const response = await this.updateEvent(definition, targets, pending, context);

        if (response.isError()) {
            return { response, completed: true };
        }

        if (response.payload.result !== undefined || response.getItemCount() === 0) {
            throw new PlatformError(
                "UnsupportedEditResult",
                "A versionable edit replacement must return its target Items; use update or version for text results.",
            );
        }

        const completed: StoredItem[] = [];

        for (const node of response.payload.items) {
            if (node.type.toLowerCase() !== definition.name.toLowerCase() || !node.attributes.id) {
                throw new PlatformError(
                    "InvalidActionResult",
                    "An edit must return its target IDs.",
                );
            }

            const record = this.storage.getItem(definition.name, node.attributes.id);

            if (!record) {
                throw new PlatformError(
                    "MissingItem",
                    "The edited target disappeared before unlock.",
                );
            }

            completed.push(record);
        }

        await this.locks.unlockAfterEdit(definition, completed, pending, context);

        return { response, completed: false };
    }

    private async prepareTargets(
        definition: ItemTypeDefinition,
        records: readonly StoredItem[],
        request: Item,
        context: ExecutionContext,
    ): Promise<readonly StoredItem[]> {
        const ordered = this.orderedTargets(records, request);
        this.authorizeTargets(definition, ordered, request.getAction(), context);
        const targets = ordered.map((record) => this.currentRecord(record));

        if (request.getAction() === "edit") {
            await this.locks.lockForEdit(definition, targets, request, context);
        } else if (request.getAction() === "version") {
            for (const target of targets) {
                this.locks.assertAvailable(target);
            }
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
    ): Promise<UpdateResult> {
        const result: Item["node"][] = [];
        const enabled = request.getAttribute("serverEvents") !== "0";
        const ids = records.map((record) => record.id);

        for (const record of records) {
            const prepared = this.updateRequest(record, request, false, ids);
            await this.beforeUpdate(definition, prepared, context);

            if (this.shouldVersion(definition, record, prepared.request)) {
                // Native update restarts the selected batch from its original request.
                request.setAction("version");

                return await this.versionBatch(definition, records, request, context, true);
            }

            this.assertUnreleased(definition, record);
            const response = await this.updateGeneration(definition, prepared, context);
            result.push(...response.payload.items);
        }

        return {
            response: await this.afterUpdates(
                definition,
                result,
                this.generationMap(records, records),
                enabled,
                context,
            ),
            completed: false,
        };
    }

    private async versionBatch(
        definition: ItemTypeDefinition,
        records: readonly StoredItem[],
        request: Item,
        context: ExecutionContext,
        fromUpdate = false,
    ): Promise<UpdateResult> {
        this.authorizeTargets(definition, records, "version", context);
        const sources = records.map((record) => this.currentRecord(record));
        const criteria = versionCriteria(request, sources, fromUpdate);
        await this.beforeVersions(definition, sources, request, context);
        const prepared: PreparedVersion[] = [];

        for (const source of sources) {
            prepared.push({
                record: this.create(definition, source, context),
                copies: new Map<string, string>(),
            });
        }

        await this.locks.unlockVersionSources(definition, sources, context);
        await this.finishVersions(definition, sources, prepared, context);
        const generated = versionedRequest(
            criteria,
            request,
            sources,
            prepared,
            !manualVersioning(this.storage, definition),
        );
        const copies = new Map(prepared.flatMap((target) => [...target.copies]));
        rememberRequestCopies(request, copies);
        remapVersionRelationships(this.storage, generated, copies, context);
        request.payload.items = generated.payload.items;

        try {
            const response = await this.runners.update(
                definition,
                generated,
                context,
                async (pending, nested) => ({
                    response: await this.updateVersions(
                        definition,
                        sources,
                        prepared,
                        pending,
                        nested,
                    ),
                    completed: false,
                }),
            );

            return { response, completed: true };
        } finally {
            request.payload.items = generated.payload.items;
        }
    }

    private async updateVersions(
        definition: ItemTypeDefinition,
        sources: readonly StoredItem[],
        prepared: readonly PreparedVersion[],
        pending: Item,
        context: ExecutionContext,
    ): Promise<Item> {
        const ids = prepared.map((target) => target.record.id);
        const updates = prepared.map((target) => ({
            ...this.updateRequest(this.currentRecord(target.record), pending, true, ids),
            copies: target.copies,
        }));
        const targets = updates.map((target) => target.record);
        this.authorizeTargets(definition, targets, "update", context);
        const result: Item["node"][] = [];

        for (const target of updates) {
            await this.beforeUpdate(definition, target, context);
            const response = await this.updateGeneration(definition, target, context);
            result.push(...response.payload.items);
        }

        const response = await this.afterUpdates(
            definition,
            result,
            this.generationMap(sources, targets),
            pending.getAttribute("serverEvents") !== "0",
            context,
        );

        return response;
    }

    private async beforeVersions(
        definition: ItemTypeDefinition,
        records: readonly StoredItem[],
        request: Item,
        context: ExecutionContext,
    ): Promise<void> {
        for (const record of records) {
            assertActiveContext(context);
            this.storage.updateItem(definition.name, record.id, {
                is_current: 0,
                ...(record.properties.locked_by_id === undefined ? { locked_by_id: null } : {}),
            });
        }

        request.setAction("version");
        delete request.node.attributes.where;
        delete request.node.attributes.idlist;

        for (const record of records) {
            request.setProperty("id", record.id);
            this.removeManagedProperties(request, record);
            await this.runners.item(definition, "onBeforeVersion", request, true, context);

            if (
                request.getID() !== record.id ||
                request.getType() !== definition.name ||
                request.getAction() !== "version"
            ) {
                throw new PlatformError(
                    "UnsupportedContextChange",
                    "A version event cannot change the source generation, ItemType or action.",
                );
            }

            this.removeManagedProperties(request, record);
        }
    }

    private async afterUpdates(
        definition: ItemTypeDefinition,
        nodes: readonly Item["node"][],
        oldIdsNewIdsMap: Readonly<Record<string, string>>,
        enabled: boolean,
        context: ExecutionContext,
    ): Promise<Item> {
        await this.runners.after(
            definition,
            "onAfterUpdate",
            afterUpdateFrames(definition.id, oldIdsNewIdsMap),
            enabled,
            context,
        );

        return new Item({ items: [...nodes] });
    }

    private updateRequest(
        record: StoredItem,
        request: Item,
        versioned: boolean,
        idList: readonly string[],
    ): PreparedUpdate {
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
            idList,
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

        await this.runners.item(definition, "onBeforeUpdate", request, enabled, context, {
            kind: MethodEventDataKind.BeforeUpdate,
            id: record.id,
            idList: prepared.idList,
        });
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
        targets: readonly PreparedVersion[],
        context: ExecutionContext,
    ): Promise<void> {
        for (const [index, target] of targets.entries()) {
            const previous = sources[index];

            if (!previous) {
                throw new PlatformError("InvalidGeneration", "A version source is missing.");
            }

            this.copier.copy(previous, target.record, target.copies, context);
            this.references.versioned(previous, target.record, context);
            this.security.changed(previous, this.currentRecord(target.record), context);
        }

        const mapping = this.generationMap(
            sources,
            targets.map((target) => target.record),
        );
        await this.runners.after(
            definition,
            "onAfterVersion",
            afterVersionFrames(definition.id, mapping),
            true,
            context,
        );
    }

    private generationMap(
        sources: readonly StoredItem[],
        targets: readonly StoredItem[],
    ): Readonly<Record<string, string>> {
        return Object.fromEntries(
            sources.map((source, index) => {
                const target = targets[index];

                if (!target) {
                    throw new PlatformError("InvalidGeneration", "A generation target is missing.");
                }

                return [source.id, target.id];
            }),
        );
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
