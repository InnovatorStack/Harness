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
    readonly before: StoredItem;
    readonly record: StoredItem;
    readonly request: Item;
    readonly copies: Map<string, string>;
    readonly versioned: boolean;
    readonly enabled: boolean;
    readonly unlock: boolean;
    readonly select: string | undefined;
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
        const prepared: PreparedUpdate[] = [];

        for (const record of records) {
            prepared.push(await this.prepare(definition, record, request, context));
        }

        const versioned = prepared
            .filter((update) => update.versioned)
            .map((update) =>
                projectItem(this.storage, definition, this.currentRecord(update.record)),
            );
        const enabled = request.getAttribute("serverEvents") !== "0";

        if (versioned.length > 0) {
            await this.runners.collection(
                definition,
                "onAfterVersion",
                new Item({ items: versioned }),
                enabled,
                context,
            );
        }

        const result: Item["node"][] = [];

        for (const update of prepared) {
            const response = await this.updateGeneration(definition, update, context);
            result.push(...response.payload.items);
        }

        const response = new Item({ items: result });
        await this.runners.collection(definition, "onAfterUpdate", response, enabled, context);

        for (const update of prepared) {
            if (update.unlock) {
                await this.unlockAfterEdit(definition, update.record.id, response, context);
            }
        }

        return response;
    }

    private async prepare(
        definition: ItemTypeDefinition,
        original: StoredItem,
        request: Item,
        context: ExecutionContext,
    ): Promise<PreparedUpdate> {
        let record = this.currentRecord(original);
        this.security.assertMutation(definition, record, request.getAction(), context);
        this.assertCurrent(record);
        const action = request.getAction();
        const enabled = request.getAttribute("serverEvents") !== "0";

        record = await this.lockForUpdate(definition, record, action, context);

        const versioned = this.shouldVersion(definition, record, request);

        if (isReleased(record) && !versioned) {
            throw new ApplicationError(
                Item.error(
                    `Released '${definition.name}' requires a new revision before it can be changed.`,
                    "ReleasedItem",
                ),
            );
        }

        const update = request.clone();
        this.removeManagedProperties(update, record);
        const copies = new Map<string, string>();
        const before = this.classificationBaseline(definition, record, action);

        if (versioned) {
            const previous = record;
            record = await this.create(definition, record, enabled, context, copies, update);

            if (isReleased(previous)) {
                removeRevisionProperties(update, previous, record);
            }
        }

        update.setProperty("id", record.id);
        delete update.node.attributes.where;
        delete update.node.attributes.idlist;
        update.setAction("update");

        return {
            before,
            record,
            request: update,
            copies,
            versioned,
            enabled,
            unlock: action === "edit",
            select: request.node.attributes.select,
        };
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

        if (action === "update") {
            this.locks.assertOwned(record);
        } else {
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
            request.getAction() === "version" ||
            (!manual &&
                request.getAttribute("version", "1") === "1" &&
                String(record.properties.new_version ?? "0") !== "1")
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

        if (prepared.versioned && !manualVersioning(this.storage, definition)) {
            update.setProperty("new_version", 1);
        }

        await this.runners.item(definition, "onBeforeUpdate", update, enabled, context);
        validateRequest(update.node, "update");

        if (
            update.getType() !== definition.name ||
            update.getAction() !== "update" ||
            update.getID() !== record.id
        ) {
            throw new PlatformError(
                "UnsupportedContextChange",
                "An update event cannot change the target generation, ItemType or action.",
            );
        }

        this.removeManagedProperties(update, record, prepared.versioned);
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
        await this.runners.item(definition, "onAfterUpdate", response, enabled, context);

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
            prepared.before,
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

    private classificationBaseline(
        definition: ItemTypeDefinition,
        record: StoredItem,
        action: string,
    ): StoredItem {
        if (action !== "version" || !isReleased(record)) {
            return record;
        }

        // Explicit version resets the released generation before its update phase.
        return {
            ...record,
            properties: {
                ...record.properties,
                ...this.lifeCycles.revisionProperties(definition, record),
            },
        };
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

    private async create(
        definition: ItemTypeDefinition,
        previous: StoredItem,
        enabled: boolean,
        context: ExecutionContext,
        copies: Map<string, string>,
        update: Item,
    ): Promise<StoredItem> {
        const before = update.clone();
        before.setAction("version");
        before.setProperty("id", previous.id);

        await this.runners.item(definition, "onBeforeVersion", before, enabled, context);

        if (before.getID() !== previous.id || before.getType() !== definition.name) {
            throw new PlatformError(
                "UnsupportedContextChange",
                "A version event cannot change the source generation or ItemType.",
            );
        }

        this.removeManagedProperties(before, previous);
        update.payload.items = structuredClone(before.payload.items);
        const id = this.nextId();
        const after: StoredItem = {
            id,
            type: definition.name,
            properties: this.generationProperties(definition, previous),
        };
        this.revisions.assertValue(definition, after.properties.major_rev);
        assertActiveContext(context);
        this.storage.updateItem(definition.name, previous.id, {
            is_current: 0,
            locked_by_id: null,
        });
        assertActiveContext(context);
        this.storage.insertItem(after);
        this.trace.record(context, { kind: "mutation", name: "version", before: previous, after });

        return await this.finishVersion(definition, previous, after, enabled, context, copies);
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

    private async finishVersion(
        definition: ItemTypeDefinition,
        previous: StoredItem,
        after: StoredItem,
        enabled: boolean,
        context: ExecutionContext,
        copies: Map<string, string>,
    ): Promise<StoredItem> {
        await this.copier.copy(previous, after, copies, enabled, context);
        this.references.versioned(previous, after, context);
        const current = this.storage.getItem(definition.name, after.id);

        if (!current) {
            throw new PlatformError(
                "MissingItem",
                "Reference maintenance lost the new generation.",
            );
        }

        const result = new Item({ items: [projectItem(this.storage, definition, current)] });
        this.security.changed(previous, current, context);
        await this.runners.item(definition, "onAfterVersion", result, enabled, context);
        const latest = this.storage.getItem(definition.name, after.id);

        if (!latest) {
            throw new PlatformError(
                "MissingItem",
                "The after-version event removed the new generation.",
            );
        }

        return latest;
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
