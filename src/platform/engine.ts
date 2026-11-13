import { capabilityForLanguage } from "../compatibility/capabilities.js";
import { assertActiveContext, spendContext } from "../core/context.js";
import { cloneFrozenData, setOwn } from "../core/data.js";
import { defineOperation } from "../core/operation.js";
import type { ExecutionContext, HarnessModule, ModuleRegistrar } from "../core/types.js";
import type { SourceLocation } from "../diagnostics/source-location.js";
import { Item, itemNode } from "../items/item.js";
import type { ItemNode } from "../items/item.js";
import { parseItems } from "../items/xml.js";
import { MethodEventDataKind } from "../methods/event-data.js";
import type { MethodEventData } from "../methods/event-data.js";
import type { MethodDefinition, MethodExecutor, MethodPorts } from "../methods/types.js";
import { properties } from "../mocks/registry.js";
import type { MockMatch, MockRegistry } from "../mocks/registry.js";
import type { MockValue } from "../mocks/types.js";
import type { SelectQuery } from "../queries/types.js";
import type {
    CatalogEntry,
    HarnessStorage,
    ItemTypeDefinition,
    StorageValue,
    StoredItem,
} from "../storage/types.js";
import { ActionResponses } from "./action-responses.js";
import { ItemAction } from "./actions.js";
import { PlatformCatalog } from "./catalog.js";
import { creationDefaults } from "./creation.js";
import { ApplicationError, PlatformError, requireSuccess } from "./errors.js";
import { AfterEvents } from "./events/after.js";
import { afterAddFrames, afterUpdateFrames } from "./events/data.js";
import { EventReplacements } from "./events/replacement.js";
import type { ApplyEventBase } from "./events/replacement.js";
import { ServerEventVersion } from "./events/types.js";
import type { ApplyUpdateBase, EventBinding, EventRunners } from "./events/types.js";
import { GraphActions } from "./graph-actions.js";
import { LifeCycles } from "./lifecycle.js";
import type { ClassificationChange } from "./lifecycle.js";
import { ItemLocks } from "./locks.js";
import { compileProjection } from "./projection.js";
import { ItemQueries } from "./queries/engine.js";
import { matches, projectedProperties, selectedProperties } from "./query.js";
import { DependentDeletion } from "./references/deletion.js";
import { ReferenceMaintenance } from "./references/maintenance.js";
import { relationshipType } from "./relationship-type.js";
import { validateRequest } from "./request.js";
import { Revisions } from "./revisions/policy.js";
import { NativeSecurity } from "./security/policy.js";
import { AuthorizationMode } from "./security/types.js";
import type { AuthorizationPolicy, AuthorizationRequest } from "./security/types.js";
import { PlatformTrace } from "./trace.js";
import type { SourceDefinition } from "./trace.js";
import { normalizeProperties } from "./values.js";
import type { ItemReference, SeedValue } from "./values.js";
import { manualVersioning } from "./version-policy.js";
import { Versioning } from "./versioning.js";

interface CallSource {
    readonly source: SourceLocation;
    readonly sourceHash?: string;
    readonly definition: SourceDefinition;
}

interface MethodCall {
    readonly name: string;
    readonly context: Item;
    readonly eventData?: MethodEventData;
}

interface SeedCall {
    readonly type: string;
    readonly properties: Readonly<Record<string, SeedValue>>;
}

interface SeedRecord extends SeedCall {
    readonly id: string;
}

interface SqlCall {
    readonly query: string;
    readonly method: string;
    readonly values: Readonly<Record<string, MockValue>>;
}

interface MutationResult {
    readonly response: Item;
    readonly replaced: boolean;
}

interface BaseItemCall {
    readonly item: Item;
    readonly event: string;
}

export const applyItemOperation = defineOperation<Item, Item>("platform.apply");
const applyBaseItemOperation = defineOperation<BaseItemCall, Item>("platform.event-base");
export const callMethodOperation = defineOperation<MethodCall, Item>("platform.method");
export const seedOperation = defineOperation<SeedCall, ItemReference>("platform.seed");
export const seedRecordsOperation = defineOperation<readonly SeedRecord[], void>(
    "platform.seedRecords",
);
export const applyAMLOperation = defineOperation<string, Item>("platform.aml");
const applySqlOperation = defineOperation<SqlCall, Item>("platform.sql");
const deleteOwnedItemOperation = defineOperation<
    { readonly parent: StoredItem; readonly child: StoredItem; readonly enabled: boolean },
    Item
>("platform.delete-owned");

export type { AuthorizationRequest } from "./security/types.js";

export interface PlatformOptions {
    readonly userId?: () => string;
    readonly executors?: readonly MethodExecutor[];
    readonly authorization?: AuthorizationPolicy;
    readonly nextId?: () => string;
    readonly mocks?: MockRegistry;
}

const actions = new Set<string>(Object.values(ItemAction));
const reservedActions = new Set(["copy", "clone", "merge", "purge", "create", "SQL Process"]);
const claimedExecutors = new WeakSet<MethodExecutor>();

enum BoundMethodKind {
    Replacement = "replacement",
    Callback = "callback",
}

function dispatchItem(item: Item, context: ExecutionContext): Promise<Item> {
    return context.execute(applyItemOperation, item);
}

export class Platform {
    private readonly catalog: PlatformCatalog;
    private readonly executors = new Map<string, MethodExecutor>();
    private readonly ownedExecutors = new Set<MethodExecutor>();
    private readonly identity = Symbol("Harness world");
    private generation = 0;
    private readonly nextId: () => string;
    private readonly locks: ItemLocks;
    private readonly versioning: Versioning;
    private readonly lifeCycles: LifeCycles;
    private readonly revisions: Revisions;
    private readonly queries: ItemQueries;
    private readonly graph: GraphActions;
    private readonly references: ReferenceMaintenance;
    private readonly deletion: DependentDeletion;
    private readonly security: NativeSecurity;
    private readonly responses: ActionResponses;
    private readonly replacements = new EventReplacements();
    private readonly boundMethods = new WeakMap<MethodCall, BoundMethodKind>();
    private readonly baseOverrides = new WeakMap<BaseItemCall, ApplyEventBase>();
    private readonly afterEvents: AfterEvents;

    constructor(
        private readonly storage: HarnessStorage,
        private readonly options: PlatformOptions = {},
        readonly trace = new PlatformTrace(),
        private readonly now: () => Date = () => new Date(),
        select?: SelectQuery,
    ) {
        this.catalog = new PlatformCatalog(storage);
        this.responses = new ActionResponses(dispatchItem, (type) => this.hasAfterEvents(type));
        this.security = new NativeSecurity(
            storage,
            options.authorization,
            options.userId,
            now,
            this.trace,
            this.catalog.classifications,
        );
        this.references = new ReferenceMaintenance(storage, this.trace);
        this.deletion = this.createDependentDeletion();
        this.graph = new GraphActions(storage, dispatchItem);
        this.queries = new ItemQueries(
            storage,
            dispatchItem,
            select,
            (definition, records, context) => this.security.readable(definition, records, context),
        );
        this.nextId =
            options.nextId ?? (() => crypto.randomUUID().replaceAll("-", "").toUpperCase());
        this.afterEvents = this.createAfterEvents();
        const runners = this.eventRunners();
        const events = runners.item;
        this.locks = new ItemLocks(
            storage,
            this.trace,
            events,
            options.userId,
            dispatchItem,
            this.references.catalog,
            select,
        );
        this.lifeCycles = new LifeCycles(
            storage,
            this.trace,
            events,
            (name, item, context) => context.execute(callMethodOperation, { name, context: item }),
            this.references,
            this.security,
            this.catalog.classifications,
        );
        this.revisions = new Revisions(storage);
        this.versioning = new Versioning(
            storage,
            this.trace,
            this.locks,
            runners,
            this.nextId,
            this.graph,
            this.references,
            this.deletion,
            this.revisions,
            this.lifeCycles,
            this.security,
        );

        this.registerExecutors(options.executors ?? []);
    }

    private createDependentDeletion(): DependentDeletion {
        return new DependentDeletion(
            this.storage,
            this.references.catalog,
            this.references.sessions,
            dispatchItem,
            (parent, child, enabled, context) =>
                context.execute(deleteOwnedItemOperation, { parent, child, enabled }),
        );
    }

    private createAfterEvents(): AfterEvents {
        return new AfterEvents(
            (definition, name, enabled, version) =>
                this.eventBindings(definition, name, enabled, version),
            (binding, name, item, context, data) =>
                this.invokeEvent(binding, name, item, context, data),
            dispatchItem,
        );
    }

    private eventRunners(): EventRunners {
        return {
            item: (definition, name, item, enabled, context, data) =>
                this.events(
                    definition,
                    name,
                    item,
                    enabled,
                    context,
                    ServerEventVersion.Item,
                    data,
                ),

            after: (definition, name, items, enabled, context) =>
                this.afterEvents.run(definition, name, items, enabled, context),

            update: (definition, request, context, applyBase) =>
                this.updateEvent(definition, request, context, applyBase),
        };
    }

    private registerExecutors(executors: readonly MethodExecutor[]): void {
        for (const executor of executors) {
            const language = executor.language.toLowerCase();

            if (this.executors.has(language)) {
                throw new PlatformError(
                    "DuplicateExecutor",
                    `Multiple executors for '${executor.language}'.`,
                );
            }

            this.executors.set(language, executor);
        }
    }

    module(): HarnessModule {
        return {
            id: "platform",
            requires: ["packages"],

            setup: (registrar) => {
                this.setupPlatform(registrar);
            },

            reset: () => {
                this.generation += 1;
                this.security.reset();
                this.trace.reset();

                for (const executor of this.ownedExecutors) {
                    executor.reset?.();
                }
            },

            dispose: () => {
                const errors: unknown[] = [];

                for (const executor of this.ownedExecutors) {
                    try {
                        executor.dispose?.();
                    } catch (error) {
                        errors.push(error);
                    } finally {
                        claimedExecutors.delete(executor);
                    }
                }

                this.ownedExecutors.clear();

                if (errors.length) {
                    throw new AggregateError(errors, "Executor cleanup failed.");
                }
            },
        };
    }

    inspect(reference: ItemReference): StoredItem {
        this.assertReference(reference);
        const item = this.storage.getItem(reference.type, reference.id);

        if (!item) {
            throw new PlatformError(
                "MissingItem",
                `Record '${reference.type}:${reference.id}' no longer exists.`,
            );
        }

        return item;
    }

    item(reference: ItemReference, action = "get"): Item {
        const stored = this.inspect(reference);

        return new Item({
            items: [
                {
                    ...itemNode(stored.type, action),
                    attributes: { id: stored.id, action },
                    properties: { ...stored.properties },
                },
            ],
        });
    }

    find(type: string, properties: Readonly<Record<string, StorageValue>>): ItemReference {
        const definition = this.catalog.itemType(type);

        for (const name of Object.keys(properties)) {
            if (
                name !== "id" &&
                !definition.properties.some((property) => property.name === name)
            ) {
                throw new PlatformError(
                    "UnknownProperty",
                    `Unknown selector '${definition.name}.${name}'.`,
                );
            }
        }

        const records = this.storage
            .listItems(definition.name)
            .filter((record) =>
                Object.entries(properties).every(([name, value]) =>
                    matches(this.storage, definition, record, { name, value }),
                ),
            );
        const record = records[0];

        if (records.length !== 1 || !record) {
            throw new PlatformError(
                "ItemResolution",
                `Inspection of '${definition.name}' matched ${records.length} records; expected one.`,
            );
        }

        return Object.freeze({
            id: record.id,
            type: definition.name,
            world: this.identity,
            generation: this.generation,
        });
    }

    private assertReference(reference: ItemReference): void {
        if (reference.world !== this.identity || reference.generation !== this.generation) {
            throw new PlatformError(
                "InvalidReference",
                "Record reference belongs to a different world or a baseline before reset. Resolve it again from the current world.",
            );
        }
    }

    private seed(
        input: SeedCall,
        context: ExecutionContext,
        graph?: { readonly id: string; readonly targets: ReadonlySet<string> },
    ): ItemReference {
        const definition = this.catalog.itemType(input.type);
        this.catalog.assertMutable(definition);
        const properties: Record<string, StorageValue> = {};

        this.resolveSeedProperties(definition, input.properties, properties, context);

        const id = graph?.id ?? this.nextId();
        const defaults = { config_id: id, generation: 1, is_current: 1 };

        for (const [name, value] of Object.entries(defaults)) {
            if (
                definition.properties.some((property) => property.name === name) &&
                properties[name] === undefined
            ) {
                setOwn(properties, name, value);
            }
        }

        const item = {
            id,
            type: definition.name,
            properties: normalizeProperties(
                this.storage,
                definition,
                this.lifeCycles.seedProperties(definition, {
                    ...this.revisions.initial(definition, properties),
                    ...properties,
                }),
                {
                    creating: true,
                    id,
                    ...(graph ? { pendingReferences: graph.targets } : {}),
                },
            ),
        };
        assertActiveContext(context);
        this.storage.insertItem(item);
        this.trace.record(context, {
            kind: "seed",
            name: definition.name,
            after: item,
        });

        return Object.freeze({
            id,
            type: definition.name,
            world: this.identity,
            generation: this.generation,
        });
    }

    private resolveSeedProperties(
        definition: ItemTypeDefinition,
        input: Readonly<Record<string, SeedValue>>,
        properties: Record<string, StorageValue>,
        context: ExecutionContext,
    ): void {
        for (const [name, value] of Object.entries(input)) {
            spendContext(context);

            if (typeof value === "object" && value !== null) {
                this.assertReference(value);
                this.inspect(value);
                const property = definition.properties.find((property) => property.name === name);
                const target = property?.dataSource
                    ? this.storage.listItemTypes().find((type) => type.id === property.dataSource)
                    : undefined;

                if (
                    property?.dataType !== "item" ||
                    (target && target.name.toLowerCase() !== value.type.toLowerCase())
                ) {
                    throw new PlatformError(
                        "InvalidReference",
                        `Record reference is not valid for '${definition.name}.${name}'.`,
                    );
                }

                setOwn(properties, name, value.id);
            } else {
                setOwn(properties, name, value);
            }
        }
    }

    private async authorize(
        request: AuthorizationRequest,
        restricted: boolean,
        context: ExecutionContext,
    ): Promise<void> {
        if (this.options.authorization === AuthorizationMode.Native) {
            this.security.authorize(request, context);
        } else if (this.options.authorization === AuthorizationMode.Unchecked) {
            this.trace.record(context, {
                kind: "authorization",
                name: "explicitly unchecked",
            });
        } else if (this.options.authorization) {
            await this.options.authorization(request);
        } else if (restricted) {
            throw new PlatformError(
                "AuthorizationRequired",
                `Authorization rules exist for '${request.name}'. Supply an authorization policy or explicitly choose unchecked execution for a behavior-only test.`,
            );
        }
    }

    private async callBoundMethod(
        input: MethodCall,
        context: ExecutionContext,
        kind = BoundMethodKind.Replacement,
    ): Promise<Item> {
        assertActiveContext(context);
        this.boundMethods.set(input, kind);

        try {
            return await context.execute(callMethodOperation, input);
        } finally {
            this.boundMethods.delete(input);
        }
    }

    private async authorizeMethod(
        input: MethodCall,
        name: string,
        entry: CatalogEntry | undefined,
        context: ExecutionContext,
        checkExecutionIdentity: boolean,
    ): Promise<void> {
        if (!checkExecutionIdentity && this.security.enabled) {
            this.security.authorizeMethodSession(context);
            this.trace.record(context, { kind: "authorization", name: "native Method NoCheck" });

            return;
        }

        await this.authorize(
            { kind: "method", name, item: input.context },
            checkExecutionIdentity && Boolean(entry?.properties.execution_allowed_to),
            context,
        );
    }

    private async callMethod(input: MethodCall, context: ExecutionContext): Promise<Item> {
        using permissions = this.security.methods.enter(context, this.boundMethods.has(input));
        const entry = this.catalog.methodEntry(input.name);
        const name =
            typeof entry?.properties.name === "string" ? entry.properties.name : input.name;
        const names = [input.name, name];

        if (entry) {
            names.push(entry.id);
        }

        const mocked = this.options.mocks?.method(names, input.context);

        if (mocked) {
            await this.authorizeMethod(
                input,
                name,
                entry,
                context,
                permissions.checkExecutionIdentity,
            );

            return this.checkedMethodResult(
                input,
                this.mockedMethodResult(name, entry, mocked, context),
            );
        }

        const definition = this.catalog.method(input.name);
        const source: CallSource = {
            source: definition.source,
            sourceHash: definition.hash,
            definition: { type: "Method", id: definition.id },
        };
        this.trace.record(context, { kind: "method", name: definition.name, ...source });
        await this.authorizeMethod(
            input,
            definition.name,
            entry,
            context,
            permissions.checkExecutionIdentity,
        );
        const executor = this.executorFor(definition);

        return this.checkedMethodResult(
            input,
            await this.executeMethod(
                executor,
                definition,
                input.context,
                source,
                context,
                input.eventData,
            ),
        );
    }

    private checkedMethodResult(input: MethodCall, result: Item): Item {
        if (this.boundMethods.get(input) === BoundMethodKind.Callback && result.isError()) {
            throw new ApplicationError(result);
        }

        return result;
    }

    private async executeMethod(
        executor: MethodExecutor,
        definition: MethodDefinition,
        item: Item,
        source: CallSource,
        context: ExecutionContext,
        data?: MethodEventData,
    ): Promise<Item> {
        let executed = false;
        let acceptingSignals = true;
        using identityScope = this.security.grants.scope(context);
        using eventScope = this.replacements.scope(definition.id, context);
        const executionStarted = (): void => {
            if (acceptingSignals && !executed) {
                executed = true;
                this.trace.record(context, { kind: "execution", name: definition.name, ...source });
            }
        };

        try {
            const result = await executor.execute(definition, item, {
                ...this.methodPorts(definition, item, context, executionStarted),
                security: identityScope,
                ...(eventScope ? { serverEvent: eventScope } : {}),
                ...(data ? { eventData: cloneFrozenData(data) } : {}),
            });
            // An adapter that completes execution provides evidence even without an early-start
            // signal.
            executionStarted();

            if (result.isError() && result.getErrorCode() !== "0") {
                this.trace.record(context, {
                    kind: "result",
                    name: definition.name,
                    result: result.payload,
                });
            }

            return requireSuccess(result);
        } finally {
            acceptingSignals = false;
        }
    }

    private executorFor(definition: MethodDefinition): MethodExecutor {
        const executor = this.executors.get(definition.language.toLowerCase());
        const capability = capabilityForLanguage(definition.language);

        if (!executor) {
            throw new PlatformError(
                "MissingExecutor",
                `Method '${definition.name}' requires a '${definition.language}' executor ` +
                    `(${definition.source.file}:${definition.source.line}).`,
                capability !== undefined ? { capability } : undefined,
            );
        }

        return executor;
    }

    private mockResult(
        name: string,
        mock: MockMatch,
        context: ExecutionContext,
        source?: CallSource,
    ): Item {
        this.trace.record(context, {
            kind: "mock",
            name,
            ...source,
            result: mock.result.payload,
            mock: {
                definition: mock.definition,
                responseHash: mock.responseHash,
                parameters: mock.parameters,
                ...(mock.responseFile ? { responseFile: mock.responseFile } : {}),
            },
        });

        return requireSuccess(mock.result);
    }

    private eventBindings(
        definition: ItemTypeDefinition,
        name: string,
        enabled: boolean,
        version = ServerEventVersion.Item,
    ) {
        return this.catalog.events(definition, name, enabled, version);
    }

    private hasAfterEvents(type: string): boolean {
        const definition = this.catalog.itemType(type);
        const names = [
            "onAfterAdd",
            "onAfterUpdate",
            "onAfterMethod",
            "onAfterLock",
            "onAfterUnlock",
        ];

        return names.some((name) =>
            [ServerEventVersion.Item, ServerEventVersion.Collection].some(
                (version) => this.eventBindings(definition, name, true, version).length > 0,
            ),
        );
    }

    private async events(
        definition: ItemTypeDefinition,
        name: string,
        item: Item,
        enabled: boolean,
        context: ExecutionContext,
        version = ServerEventVersion.Item,
        data?: MethodEventData,
    ): Promise<void> {
        const bindings = [...this.eventBindings(definition, name, enabled, version)];

        if (data?.kind === MethodEventDataKind.BeforeUpdate) {
            bindings.push(
                ...this.eventBindings(definition, name, enabled, ServerEventVersion.Collection),
            );
            bindings.sort(
                (left, right) =>
                    Number(left.entry.properties.sort_order ?? 0) -
                    Number(right.entry.properties.sort_order ?? 0),
            );
        }

        for (const binding of bindings) {
            if (binding.version === ServerEventVersion.Collection && data) {
                await this.invokeEvent(binding, name, Item.create(""), context, data);

                continue;
            }

            if (version === ServerEventVersion.Item) {
                await this.hydrateEventItem(name, item, context);
            }

            await this.invokeEvent(binding, name, item, context, data);
        }
    }

    private async invokeEvent(
        binding: EventBinding,
        name: string,
        item: Item,
        context: ExecutionContext,
        data?: MethodEventData,
    ): Promise<void> {
        this.trace.record(context, { kind: "event", name, source: binding.entry.source });
        // Callbacks share their input; the separate response supplies faults, not input patches.
        await this.callBoundMethod(
            {
                name: binding.methodId,
                context: item,
                ...(data ? { eventData: data } : {}),
            },
            context,
            BoundMethodKind.Callback,
        );
    }

    private async hydrateEventItem(
        name: string,
        item: Item,
        context: ExecutionContext,
    ): Promise<void> {
        if (name === "onAfterGet" || item.getItemCount() !== 1) {
            return;
        }

        const node = item.node;

        if (
            !node.attributes.id ||
            Object.keys(node.attributes).length !== 1 ||
            Object.keys(node.properties).length > 0 ||
            Object.keys(node.propertyItems).length > 0 ||
            Object.keys(node.propertyAttributes).length > 0 ||
            node.relationships.length > 0 ||
            (node.logical?.length ?? 0) > 0
        ) {
            return;
        }

        const request = Item.create(node.type, "get");
        request.setProperty("id", node.attributes.id);
        const result = requireSuccess(await dispatchItem(request, context));

        if (result.isError() || result.getItemCount() === 0) {
            throw new ApplicationError(
                Item.error(
                    `Cannot load '${node.type}:${node.attributes.id}' for '${name}'.`,
                    "ItemNotFound",
                ),
            );
        }

        item.payload.items = result.getItemByIndex(0).clone().payload.items;
    }

    private async apply(item: Item, context: ExecutionContext, baseEvent?: string): Promise<Item> {
        const request = item.node;
        const action = request.attributes.action ?? "get";

        if (request.type.toLowerCase() === "sql" && /^sql\s+process$/i.test(action)) {
            return this.applySqlProcess(item, context);
        }

        if (reservedActions.has(action)) {
            throw new PlatformError(
                "UnsupportedAction",
                `Platform action '${action}' is not implemented.`,
            );
        }

        if (!actions.has(action)) {
            return await context.execute(callMethodOperation, {
                name: action,
                context: item,
            });
        }

        const definition = this.catalog.itemType(request.type);
        validateRequest(request, action);

        if (action !== "get") {
            this.responses.prepare(request, context);
        }

        this.traceAction(definition, item, action, context);
        const enabled = request.attributes.serverEvents !== "0";
        this.assertActionSupported(definition, action);
        await this.authorizeAction(definition, action, item, context);

        if (["lock", "unlock", "promoteItem"].includes(action)) {
            return await this.applyStateAction(definition, item, context, baseEvent);
        }

        const verb = ["edit", "version"].includes(action)
            ? "Update"
            : action[0]?.toUpperCase() + action.slice(1);

        if (
            !["get", "add"].includes(action) &&
            !(definition.isVersionable && ["edit", "update", "version"].includes(action))
        ) {
            return await this.mutateExisting(definition, item, verb, enabled, context, baseEvent);
        }

        return await this.applyStandardAction(definition, item, verb, enabled, context, baseEvent);
    }

    private async applyStandardAction(
        definition: ItemTypeDefinition,
        item: Item,
        verb: string,
        enabled: boolean,
        context: ExecutionContext,
        baseEvent?: string,
    ): Promise<Item> {
        const action = item.getAction();

        if (definition.isVersionable && ["edit", "update", "version"].includes(action)) {
            return await this.applyVersionedUpdate(definition, item, context);
        }

        const targetId = item.node.attributes.id;
        const replacement = await this.replaceAction(
            definition,
            item,
            verb,
            enabled,
            context,
            baseEvent,
        );

        if (replacement) {
            return replacement;
        }

        const responseRequest = { ...item.node, attributes: { ...item.node.attributes } };
        await this.events(definition, `onBefore${verb}`, item, enabled, context);
        const request = item.node;
        validateRequest(request, action);

        this.assertActionContext(definition, request, action, targetId);

        if (action === "get") {
            return await this.get(definition, item.node, enabled, context);
        }

        return await this.add(definition, item, enabled, responseRequest, context);
    }

    private assertActionContext(
        definition: ItemTypeDefinition,
        request: ItemNode,
        action: string,
        targetId: string | undefined,
    ): void {
        if (
            request.type.toLowerCase() !== definition.name.toLowerCase() ||
            (request.attributes.action ?? "get") !== action ||
            (action !== "get" && targetId !== undefined && request.attributes.id !== targetId)
        ) {
            throw new PlatformError(
                "UnsupportedContextChange",
                "A before event cannot change the ItemType, action or explicit target ID.",
            );
        }
    }

    private async authorizeAction(
        definition: ItemTypeDefinition,
        action: string,
        item: Item,
        context: ExecutionContext,
    ): Promise<void> {
        let restricted = false;

        if (this.options.authorization === undefined) {
            const metadata = this.storage.getCatalogEntry("ItemType", definition.id);
            restricted =
                this.storage
                    .listCatalogEntries("Allowed Permission")
                    .some((entry) => entry.properties.source_id === definition.id) ||
                metadata?.properties.use_src_access === "1";
        }

        await this.authorize(
            { kind: "action", name: `${definition.name}.${action}`, item },
            restricted,
            context,
        );
    }

    private traceAction(
        definition: ItemTypeDefinition,
        item: Item,
        action: string,
        context: ExecutionContext,
    ): void {
        this.trace.record(context, {
            kind: "action",
            name: `${definition.name}.${action}`,
            request: item.payload,
            ...(definition.source ? { source: definition.source } : {}),
        });
    }

    private async applyStateAction(
        definition: ItemTypeDefinition,
        item: Item,
        context: ExecutionContext,
        baseEvent?: string,
    ): Promise<Item> {
        const action = item.getAction();
        let verb = "Unlock";

        if (action === "promoteItem") {
            verb = "Promote";
        } else if (action === "lock") {
            verb = "Lock";
        }

        const replacement = await this.replaceAction(
            definition,
            item,
            verb,
            item.getAttribute("serverEvents") !== "0",
            context,
            baseEvent,
        );

        if (replacement) {
            return replacement;
        }

        const records = await this.query(definition, item.node, context);

        if (!records.length) {
            throw new ApplicationError(
                Item.error(
                    `No '${definition.name}' records match this ${action} request.`,
                    "NoItems",
                ),
            );
        }

        const result: ItemNode[] = [];

        for (const record of records) {
            const response = await this.applyStateTarget(definition, record, item, context);
            result.push(...response.payload.items);
        }

        return await this.responses.complete(item.node, new Item({ items: result }), context);
    }

    private async applyStateTarget(
        definition: ItemTypeDefinition,
        record: StoredItem,
        item: Item,
        context: ExecutionContext,
    ): Promise<Item> {
        const action = item.getAction();
        this.security.assertMutation(definition, record, action, context);

        if (definition.isVersionable) {
            this.versioning.assertCurrent(record);
        }

        if (action === "promoteItem") {
            this.locks.assertAvailable(record);

            return await this.lifeCycles.promote(definition, record, item, context, (transition) =>
                this.authorizeTransition(transition, record, item, context),
            );
        }

        return await this.locks.base(
            definition,
            record,
            action === "lock" ? "lock" : "unlock",
            context,
            item,
        );
    }

    private async authorizeTransition(
        transition: CatalogEntry,
        record: StoredItem,
        item: Item,
        context: ExecutionContext,
    ): Promise<void> {
        if (this.security.enabled) {
            this.security.transition(transition, record, context);

            return;
        }

        await this.authorize(
            { kind: "transition", name: transition.id, item },
            Boolean(transition.properties.role),
            context,
        );
    }

    private applySqlProcess(item: Item, context: ExecutionContext): Item {
        const name = item.getProperty("name");
        const mocked = this.options.mocks?.sql(name, properties(item));

        if (mocked) {
            return this.mockResult(`SQL Process: ${name}`, mocked, context, this.sqlSource(name));
        }

        return this.unsupportedSqlProcess(item, context);
    }

    private unsupportedSqlProcess(item: Item, context: ExecutionContext): never {
        const name = item.getProperty("name");
        const definitions = this.storage
            .listCatalogEntries("SQL")
            .filter(
                (definition) =>
                    String(definition.properties.name).toLowerCase() === name.toLowerCase(),
            );
        const definition = definitions[0];

        if (definitions.length !== 1 || !definition) {
            throw new PlatformError(
                "SqlResolution",
                `SQL '${name}' resolved to ${definitions.length} imported definitions.`,
            );
        }

        const body = definition.properties.sqlserver_body;

        if (typeof body !== "string") {
            throw new PlatformError(
                "InvalidSqlDefinition",
                `SQL '${name}' has no sqlserver_body source.`,
            );
        }

        this.trace.record(context, {
            kind: "action",
            name: `SQL Process: ${name}`,
            source: definition.source,
            sourceHash: new Bun.CryptoHasher("sha256").update(body).digest("hex"),
            definition: { type: "SQL", id: definition.id },
        });

        throw new PlatformError(
            "UnsupportedSQL",
            `T-SQL execution is not implemented for '${name}' (${definition.source.file}:${definition.source.line}).`,
        );
    }

    private sqlSource(name: string): CallSource | undefined {
        const definitions = this.storage
            .listCatalogEntries("SQL")
            .filter((entry) => String(entry.properties.name).toLowerCase() === name.toLowerCase());
        const entry = definitions[0];

        if (definitions.length !== 1 || !entry) {
            return undefined;
        }

        const body = entry.properties.sqlserver_body;

        return {
            source: entry.source,
            definition: { type: "SQL", id: entry.id },
            ...(typeof body === "string"
                ? { sourceHash: new Bun.CryptoHasher("sha256").update(body).digest("hex") }
                : {}),
        };
    }

    private async query(
        definition: ItemTypeDefinition,
        request: ItemNode,
        context: ExecutionContext,
    ): Promise<readonly StoredItem[]> {
        return (await this.queries.run(definition, request, context)).records;
    }

    private async add(
        definition: ItemTypeDefinition,
        item: Item,
        enabled: boolean,
        responseRequest: ItemNode,
        context: ExecutionContext,
    ): Promise<Item> {
        const request = item.node;

        if (request.attributes.where) {
            throw new PlatformError("InvalidAdd", "add cannot contain a where selector.");
        }

        await this.graph.properties(definition, request, context);
        const id = request.attributes.id ?? this.nextId();
        this.assertAddProperties(definition, request);
        const properties = this.creationProperties(definition, request, id, context);
        Object.assign(properties, this.security.creation(definition, properties, context));
        const record = this.references.initialize(definition, {
            id,
            type: definition.name,
            properties: normalizeProperties(this.storage, definition, properties, {
                creating: true,
                id,
            }),
        });
        assertActiveContext(context);
        this.storage.insertItem(record);
        this.references.sessions.created(record, context);
        this.trace.record(context, {
            kind: "mutation",
            name: "add",
            after: record,
        });
        const children = await this.graph.relationships(definition, request, id, context);

        const response = this.recordResponse(definition, record, request, children);
        await this.afterEvents.run(
            definition,
            "onAfterAdd",
            afterAddFrames(definition.id, id),
            enabled,
            context,
        );

        return await this.responses.complete(responseRequest, response, context);
    }

    private setupPlatform(registrar: ModuleRegistrar): void {
        registrar.handleAsync(deleteOwnedItemOperation, (input, context) =>
            this.deleteOwned(input.parent, input.child, input.enabled, context),
        );

        for (const executor of this.executors.values()) {
            if (claimedExecutors.has(executor)) {
                throw new PlatformError(
                    "ExecutorAlreadyAttached",
                    "Create a separate executor instance for each harness world.",
                );
            }
        }

        for (const executor of this.executors.values()) {
            claimedExecutors.add(executor);
            this.ownedExecutors.add(executor);
        }

        this.registerSeedOperations(registrar);
        registrar.handleAsync(applyBaseItemOperation, (input, context) =>
            this.references.sessions.run(context, () => this.applyBaseItem(input, context)),
        );
        registrar.handleAsync(applyItemOperation, (item, context) =>
            this.references.sessions.run(context, () => this.apply(item.clone(), context)),
        );
        registrar.handleAsync(callMethodOperation, (input, context) =>
            this.references.sessions.run(context, () => this.callMethod(input, context)),
        );
        registrar.handleAsync(applySqlOperation, async (input, context) => {
            const mocked = this.options.mocks?.sql(true, {
                ...input.values,
                method: input.method,
                query: input.query,
            });

            if (mocked) {
                return this.mockResult(`SQL: ${input.method}`, mocked, context);
            }

            throw new PlatformError(
                "UnsupportedSQL",
                `T-SQL execution is not implemented (called by '${input.method}').`,
            );
        });
        registrar.handleAsync(applyAMLOperation, (xml, context) =>
            this.references.sessions.run(context, () => this.applyAML(xml, context)),
        );
    }

    private async deleteOwned(
        parent: StoredItem,
        child: StoredItem,
        enabled: boolean,
        context: ExecutionContext,
    ): Promise<Item> {
        const owner = this.storage.getItem(parent.type, parent.id);
        const record = this.storage.getItem(child.type, child.id);

        if (
            !owner ||
            !record ||
            String(record.properties.source_id).toLowerCase() !== owner.id.toLowerCase()
        ) {
            throw new PlatformError(
                "RelationshipSource",
                "An owned deletion requires its persisted parent.",
            );
        }

        relationshipType(this.storage, this.catalog.itemType(parent.type), child.type);
        const request = Item.create(child.type, "delete");
        request.setAttribute("id", child.id);

        if (!enabled) {
            request.setAttribute("serverEvents", "0");
        }

        return await this.security.deletingOwned(record, context, () =>
            context.execute(applyBaseItemOperation, { item: request, event: "onDelete" }),
        );
    }

    private async applyAML(xml: string, context: ExecutionContext): Promise<Item> {
        const nodes: ItemNode[] = [];
        const requests = parseItems(xml);

        for (const item of requests) {
            const result = requireSuccess(await context.execute(applyItemOperation, item));

            if (requests.length === 1) {
                return result;
            }

            if (result.isError()) {
                throw new PlatformError(
                    "UnsupportedBatchResult",
                    "Batch AML with a no-items result is not supported.",
                );
            }

            for (const node of result.payload.items) {
                spendContext(context);
                nodes.push(node);
            }
        }

        return new Item({ items: nodes });
    }

    private registerSeedOperations(registrar: ModuleRegistrar): void {
        registrar.handleSync(seedOperation, (input, context) => this.seed(input, context));
        registrar.handleSync(seedRecordsOperation, (records, context) => {
            const targets = new Set(
                records.map((record) =>
                    JSON.stringify([record.type.toLowerCase(), record.id.toLowerCase()]),
                ),
            );

            for (const record of records) {
                this.seed(record, context, { id: record.id, targets });
            }
        });
    }

    private assertActionSupported(definition: ItemTypeDefinition, action: string): void {
        if (action !== "get") {
            this.catalog.assertMutable(definition);
        }

        if (action === "version" && !definition.isVersionable) {
            throw new PlatformError(
                "NotVersionable",
                `ItemType '${definition.name}' is not versionable.`,
            );
        }

        if (
            action === "edit" &&
            !definition.isVersionable &&
            this.storage
                .listCatalogEntries("Server Event")
                .some(
                    (event) =>
                        event.properties.source_id === definition.id &&
                        /lock/i.test(String(event.properties.server_event)),
                )
        ) {
            throw new PlatformError(
                "UnsupportedLocking",
                `edit on '${definition.name}' requires lock event semantics that are not implemented.`,
            );
        }
    }

    private async replaceAction(
        definition: ItemTypeDefinition,
        item: Item,
        verb: string,
        enabled: boolean,
        context: ExecutionContext,
        baseEvent?: string,
        applyBase?: ApplyEventBase,
    ): Promise<Item | undefined> {
        if (baseEvent === `on${verb}`) {
            return undefined;
        }

        const replacement = this.eventBindings(definition, `on${verb}`, enabled);

        if (replacement.length) {
            if (replacement.length !== 1) {
                throw new PlatformError(
                    "AmbiguousReplacement",
                    `Multiple replacement handlers for '${definition.name}.on${verb}' are not supported.`,
                );
            }

            const binding = replacement[0];

            if (!binding) {
                throw new PlatformError("InvalidEvent", "Missing replacement binding.");
            }

            this.trace.record(context, {
                kind: "event",
                name: `on${verb}`,
                source: binding.entry.source,
            });

            return await this.replacements.invoke(
                binding,
                `on${verb}`,
                item,
                context,
                (request, nested) => this.delegateBase(request, `on${verb}`, nested, applyBase),
                () => this.callBoundMethod({ name: binding.methodId, context: item }, context),
            );
        }

        return undefined;
    }

    private async delegateBase(
        item: Item,
        event: string,
        context: ExecutionContext,
        applyBase?: ApplyEventBase,
    ): Promise<Item> {
        const input = { item, event };

        if (applyBase) {
            this.baseOverrides.set(input, applyBase);
        }

        try {
            return await context.execute(applyBaseItemOperation, input);
        } finally {
            this.baseOverrides.delete(input);
        }
    }

    private async applyBaseItem(input: BaseItemCall, context: ExecutionContext): Promise<Item> {
        const applyBase = this.baseOverrides.get(input);
        const request = input.item.clone();

        try {
            if (applyBase) {
                return await applyBase(request, context);
            }

            return await this.apply(request, context, input.event);
        } finally {
            input.item.payload.items = request.payload.items;
        }
    }

    private async updateEvent(
        definition: ItemTypeDefinition,
        request: Item,
        context: ExecutionContext,
        applyBase: ApplyUpdateBase,
    ): Promise<Item> {
        await this.authorizeAction(definition, request.getAction(), request, context);
        const attributes = { ...request.node.attributes };
        const complete: ApplyEventBase = async (item, nested) => {
            // Native delegates capture these flags before the replacement mutates its DOM.
            for (const name of ["serverEvents", "doGetItem"]) {
                delete item.node.attributes[name];

                if (attributes[name] !== undefined) {
                    item.node.attributes[name] = attributes[name];
                }
            }

            const result = await applyBase(item, nested);

            if (result.completed) {
                return result.response;
            }

            const responseRequest = {
                ...item.node,
                attributes: { ...item.node.attributes, action: "update" },
            };

            return await this.responses.complete(responseRequest, result.response, nested);
        };
        const replacement = await this.replaceAction(
            definition,
            request,
            "Update",
            request.getAttribute("serverEvents") !== "0",
            context,
            undefined,
            complete,
        );

        return replacement ?? (await complete(request, context));
    }

    private async applyVersionedUpdate(
        definition: ItemTypeDefinition,
        item: Item,
        context: ExecutionContext,
    ): Promise<Item> {
        const request = item.node;
        const action = item.getAction();
        const records = await this.query(definition, request, context);

        if (!records.length) {
            throw new ApplicationError(
                Item.error(
                    `No '${definition.name}' records match this ${action} request.`,
                    "NoItems",
                ),
            );
        }

        const result = await this.versioning.applyBatch(definition, records, item, context);

        if (result.completed) {
            return result.response;
        }

        return await this.responses.complete(request, result.response, context);
    }

    private async get(
        definition: ItemTypeDefinition,
        request: ItemNode,
        enabled: boolean,
        context: ExecutionContext,
    ): Promise<Item> {
        const project = compileProjection(
            this.storage,
            definition,
            request.attributes.select,
            (type, record) => this.security.readable(type, [record], context).length === 1,
        );
        const selection = await this.queries.run(definition, request, context);
        const records = selection.records;

        if (!records.length) {
            const empty = Item.error(`No items of type '${definition.name}' found.`, "0");

            if (selection.messages) {
                empty.payload.messages = selection.messages;
            }

            return empty;
        }

        const result = new Item({
            items: records.map((record) => ({
                ...project(record),
                relationships: [...(selection.relationships?.get(record.id) ?? [])],
            })),
            ...(selection.messages ? { messages: selection.messages } : {}),
        });
        await this.events(definition, "onAfterGet", result, enabled, context);

        return result;
    }

    private async mutateExisting(
        definition: ItemTypeDefinition,
        item: Item,
        verb: string,
        enabled: boolean,
        context: ExecutionContext,
        baseEvent?: string,
    ): Promise<Item> {
        const request = item.node;
        const action = item.getAction();
        const records = await this.mutationTargets(definition, item, context);
        const result: ItemNode[] = [];
        const updated: string[] = [];
        let replaced = false;

        const ids = records.map((record) => record.id);

        for (const record of records) {
            if (action === "delete" && !this.storage.getItem(record.type, record.id)) {
                continue;
            }

            const mutate = () =>
                this.mutateTarget(definition, record, item, verb, enabled, context, baseEvent, ids);
            const response =
                action === "delete"
                    ? await this.references.sessions.deleting(record, context, mutate)
                    : await mutate();

            if (response.replaced && records.length === 1) {
                return response.response;
            }

            if (response.replaced && response.response.payload.result !== undefined) {
                throw new PlatformError(
                    "UnsupportedBatchResult",
                    "A collection replacement cannot combine text responses.",
                );
            }

            result.push(...response.response.payload.items);
            replaced ||= response.replaced;

            if (!response.replaced) {
                updated.push(record.id);
            }
        }

        const response = new Item({ items: result });

        if (verb === "Update") {
            await this.afterEvents.run(
                definition,
                "onAfterUpdate",
                afterUpdateFrames(definition.id, Object.fromEntries(updated.map((id) => [id, id]))),
                enabled,
                context,
            );
        }

        return replaced ? response : await this.responses.complete(request, response, context);
    }

    private async mutationTargets(
        definition: ItemTypeDefinition,
        item: Item,
        context: ExecutionContext,
    ): Promise<readonly StoredItem[]> {
        const records = await this.query(definition, item.node, context);
        const action = item.getAction();

        if (records.length === 0) {
            throw new ApplicationError(
                Item.error(
                    `No '${definition.name}' records match this ${action} request.`,
                    "NoItems",
                ),
            );
        }

        return action === "delete" ? this.deletionTargets(definition, records, context) : records;
    }

    private deletionTargets(
        definition: ItemTypeDefinition,
        records: readonly StoredItem[],
        context: ExecutionContext,
    ): readonly StoredItem[] {
        let targets = records;

        if (definition.isVersionable) {
            targets = [
                ...new Map(
                    records
                        .flatMap((record) => this.versioning.family(record))
                        .map((record) => [record.id, record]),
                ).values(),
            ];
        }

        this.deletion.prepare(targets, context);

        return targets;
    }

    private async mutateTarget(
        definition: ItemTypeDefinition,
        record: StoredItem,
        original: Item,
        verb: string,
        enabled: boolean,
        context: ExecutionContext,
        baseEvent?: string,
        idList: readonly string[] = [record.id],
    ): Promise<MutationResult> {
        this.security.assertMutation(definition, record, original.getAction(), context);
        const item = original.clone();
        item.node.attributes.id = record.id;
        delete item.node.attributes.where;
        delete item.node.attributes.idlist;
        const replacement = await this.replaceAction(
            definition,
            item,
            verb,
            enabled,
            context,
            baseEvent,
        );

        if (replacement) {
            return { response: replacement, replaced: true };
        }

        return {
            response: await this.mutateTargetBase(
                definition,
                record,
                item,
                verb,
                enabled,
                context,
                idList,
            ),
            replaced: false,
        };
    }

    private async mutateTargetBase(
        definition: ItemTypeDefinition,
        record: StoredItem,
        item: Item,
        verb: string,
        enabled: boolean,
        context: ExecutionContext,
        idList: readonly string[],
    ): Promise<Item> {
        const action = item.getAction();
        await this.events(
            definition,
            `onBefore${verb}`,
            item,
            enabled,
            context,
            ServerEventVersion.Item,
            verb === "Update"
                ? { kind: MethodEventDataKind.BeforeUpdate, id: record.id, idList }
                : undefined,
        );
        const request = item.node;
        validateRequest(request, action);
        this.assertActionContext(definition, request, action, record.id);
        const classification =
            action === "delete"
                ? undefined
                : this.lifeCycles.classificationChange(
                      definition,
                      record,
                      request.properties,
                      context,
                  );
        await this.graph.properties(definition, request, context);

        if (action === "delete") {
            await this.deletion.children(record, enabled, context);
        }

        this.mutateRecord(definition, record, request, action, context, classification);
        let stored =
            action === "delete" ? record : this.storage.getItem(definition.name, record.id);

        if (!stored) {
            throw new PlatformError("MissingItem", "Action result is missing.");
        }

        await this.deletion.changed(
            record,
            action === "delete" ? undefined : stored,
            enabled,
            context,
        );
        const children = await this.graph.relationships(definition, request, record.id, context);
        stored = this.lifeCycles.applyClassification(stored, classification, context);
        const response = this.recordResponse(definition, stored, request, children);
        this.security.changed(record, stored, context);

        if (verb !== "Update") {
            await this.events(definition, `onAfter${verb}`, response, enabled, context);
        }

        return response;
    }

    private recordResponse(
        definition: ItemTypeDefinition,
        record: StoredItem,
        request: ItemNode,
        children: ItemNode[],
    ): Item {
        return new Item({
            items: [
                {
                    ...itemNode(definition.name),
                    attributes: { id: record.id },
                    properties: projectedProperties(
                        this.storage,
                        definition,
                        record,
                        selectedProperties(request),
                    ),
                    relationships: children,
                },
            ],
        });
    }

    private mutateRecord(
        definition: ItemTypeDefinition,
        record: StoredItem,
        request: ItemNode,
        action: string,
        context: ExecutionContext,
        classification: ClassificationChange | undefined,
    ): void {
        if (Boolean(record.properties.locked_by_id)) {
            throw new PlatformError(
                "UnsupportedLocking",
                `Cannot mutate locked '${definition.name}' record '${record.id}' without lock ownership support.`,
            );
        }

        if (action === "delete") {
            this.deletion.assertRemovable(record, context);
            assertActiveContext(context);
            this.storage.deleteItem(definition.name, record.id);
            this.references.sessions.deleted(record, context);
            this.trace.record(context, {
                kind: "mutation",
                name: "delete",
                before: record,
            });
        } else {
            this.updateRecord(definition, record, request, context, classification);
        }
    }

    private updateRecord(
        definition: ItemTypeDefinition,
        record: StoredItem,
        request: ItemNode,
        context: ExecutionContext,
        classification: ClassificationChange | undefined,
    ): void {
        const normalized = normalizeProperties(this.storage, definition, request.properties, {
            creating: false,
            current: record,
        });
        const values = this.lifeCycles.authorizeUpdate(
            definition,
            record,
            normalized,
            classification,
            context,
        );

        if (definition.isRelationship) {
            const prepared = this.references.initialize(definition, {
                ...record,
                properties: { ...record.properties, ...values },
            });
            const behavior = prepared.properties.behavior;

            if (typeof behavior !== "string") {
                throw new TypeError("A relationship must retain its resolved behavior.");
            }

            values.behavior = behavior;
        }

        assertActiveContext(context);
        this.storage.updateItem(
            definition.name,
            record.id,
            this.security.auditedChanges(record, values),
        );
        const after = this.storage.getItem(definition.name, record.id);

        if (!after) {
            throw new PlatformError("MissingItem", "Updated record disappeared.");
        }

        this.trace.record(context, { kind: "mutation", name: "update", before: record, after });
    }

    private assertAddProperties(definition: ItemTypeDefinition, request: ItemNode): void {
        if (definition.isVersionable) {
            for (const name of [
                "config_id",
                "generation",
                "is_current",
                "new_version",
                "locked_by_id",
            ]) {
                if (request.properties[name] !== undefined) {
                    throw new PlatformError(
                        "ReadOnlyProperty",
                        `Version property '${definition.name}.${name}' is managed by add. Use fixtures to seed existing generations.`,
                    );
                }
            }
        }
    }

    private creationProperties(
        definition: ItemTypeDefinition,
        request: ItemNode,
        id: string,
        context: ExecutionContext,
    ): Record<string, StorageValue> {
        const classification =
            request.properties.classification === undefined
                ? definition.properties.find((property) => property.name === "classification")
                      ?.defaultValue
                : request.properties.classification;
        this.catalog.classifications.assertValue(definition, classification, context);
        const properties: Record<string, StorageValue> = {
            config_id: id,
            generation: 1,
            is_current: 1,
            new_version:
                definition.isVersionable && !manualVersioning(this.storage, definition) ? 0 : 1,
            ...this.revisions.initial(definition, request.properties),
            ...(classification === undefined ? {} : { classification }),
            ...request.properties,
            ...this.lifeCycles.initialProperties(definition, classification),
            ...creationDefaults(definition, request.properties, this.options.userId, this.now),
        };
        this.revisions.assertValue(definition, properties.major_rev);

        return properties;
    }

    private methodPorts(
        definition: MethodDefinition,
        item: Item,
        context: ExecutionContext,
        executionStarted: () => void,
    ): MethodPorts {
        const capability = capabilityForLanguage(definition.language);

        return {
            executionStarted,

            getNewId: () => {
                assertActiveContext(context);

                return this.nextId();
            },

            apply: (item) => context.execute(applyItemOperation, item),

            applyMethod: (name, item) =>
                context.execute(callMethodOperation, { name, context: item }),

            applyAML: (xml) => context.execute(applyAMLOperation, xml),

            applySQL: (query, parameters) =>
                context.execute(applySqlOperation, {
                    query,
                    method: definition.name,
                    values: {
                        ...properties(item),
                        ...(parameters === undefined ? {} : { parameters }),
                    },
                }),

            getUserId: () => {
                assertActiveContext(context);

                if (!this.options.userId) {
                    throw new PlatformError(
                        "SessionRequired",
                        "This Method requires a configured User session.",
                    );
                }

                return this.options.userId();
            },

            fail: (message) =>
                context.fail(
                    new PlatformError(
                        "UnsupportedCapability",
                        `${definition.name}: ${message} ` +
                            `(${definition.source.file}:${definition.source.line})`,
                        {
                            source: definition.source,
                            ...(capability !== undefined ? { capability } : {}),
                        },
                    ),
                ),
        };
    }

    private mockedMethodResult(
        name: string,
        entry: CatalogEntry | undefined,
        mocked: MockMatch,
        context: ExecutionContext,
    ): Item {
        const code = entry?.properties.method_code;

        return this.mockResult(
            name,
            mocked,
            context,
            entry
                ? {
                      source: entry.source,
                      definition: { type: "Method", id: entry.id },
                      ...(typeof code === "string"
                          ? {
                                sourceHash: new Bun.CryptoHasher("sha256")
                                    .update(code)
                                    .digest("hex"),
                            }
                          : {}),
                  }
                : undefined,
        );
    }
}
