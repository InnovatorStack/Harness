import { builtinDatabase } from "../baseline/database.js";
import type { ClockControl } from "../controls/clock.js";
import type { FailureInjection, InjectedFailureHandle } from "../controls/failure-types.js";
import type { ExecutionObserver, Observation } from "../controls/observers.js";
import { createStateReader } from "../controls/state.js";
import type { StateReader } from "../controls/state.js";
import type { ValuePosition, ValueSettings } from "../controls/values.js";
import { WorldControls } from "../controls/world.js";
import { RuntimeError } from "../core/errors.js";
import { createRuntime } from "../core/runtime.js";
import type { Runtime } from "../core/runtime.js";
import type { HarnessModule } from "../core/types.js";
import { createFixtureModule } from "../fixtures/module.js";
import type { ExecutionReport } from "../instrumentation/types.js";
import type { Item } from "../items/item.js";
import { loadAmlDocuments } from "../packages/files.js";
import type { PackageLoadReport } from "../packages/importer.js";
import {
    createPackageModule,
    importPackageDocuments,
    importSetupDocuments,
} from "../packages/module.js";
import { withImportBaseline } from "../packages/state.js";
import type { AmlDocument } from "../packages/types.js";
import {
    Platform,
    applyItemOperation,
    applyAMLOperation,
    callMethodOperation,
    seedOperation,
} from "../platform/engine.js";
import type { PlatformOptions } from "../platform/engine.js";
import { ApplicationError } from "../platform/errors.js";
import type { PlatformTraceEvent } from "../platform/trace.js";
import { PlatformTrace } from "../platform/trace.js";
import type { ItemReference, SeedValue } from "../platform/values.js";
import { selectQuery } from "../queries/types.js";
import { SqliteStorage } from "../storage/sqlite/storage.js";
import {
    setCheckpoint,
    restoreCheckpoint,
    retainCheckpoint,
} from "../storage/sqlite/transactions.js";
import type { HarnessStorage, StorageValue, StoredItem } from "../storage/types.js";

export interface EngineOptions extends PlatformOptions, ValueSettings {
    readonly database?: string;
    readonly storage?: HarnessStorage;
    readonly modules?: readonly HarnessModule[];
}

export interface Engine {
    readonly state: StateReader;
    readonly clock: ClockControl;
    observe(callback: ExecutionObserver): Observation;
    injectFailure(injection: FailureInjection): InjectedFailureHandle;
    readonly runtime: Runtime;
    readonly storage: HarnessStorage;
    readonly trace: readonly PlatformTraceEvent[];
    readonly executions: readonly ExecutionReport[];
    clearExecutions(): void;
    seed(type: string, properties: Readonly<Record<string, SeedValue>>): ItemReference;
    inspect(reference: ItemReference): StoredItem;
    find(type: string, properties: Readonly<Record<string, StorageValue>>): ItemReference;
    item(reference: ItemReference, action?: string): Item;
    apply(item: Item): Promise<Item>;
    applyAML(xml: string): Promise<Item>;
    callMethod(name: string, context: Item): Promise<Item>;
    loadPackages(paths: readonly string[]): Promise<PackageLoadReport>;
    checkpoint(): void;
    reset(): void;
    close(): void;
    [Symbol.dispose](): void;
}

interface InitialSetup {
    readonly packages: readonly AmlDocument[];
    readonly fixtures: readonly AmlDocument[];
}

export interface EngineImage {
    readonly database: Uint8Array;
    readonly values: ValuePosition;
}

/** Only configured setup captures this image, before the world is returned to application code. */
export function captureEngine(engine: Engine): EngineImage {
    if (!(engine instanceof HarnessInstance)) {
        throw new TypeError("Only an owned Harness engine can capture its setup image.");
    }

    return engine.capture();
}

/** Both entry points initialize exactly once, before exposing a usable world. */
export function openEngine(options: EngineOptions, setup?: InitialSetup | EngineImage): Engine {
    if (options.database !== undefined && options.storage !== undefined) {
        throw new TypeError("Supply a database path or a storage implementation, not both.");
    }

    if (options.ids !== undefined && options.nextId !== undefined) {
        throw new TypeError("Supply seeded IDs or nextId, not both.");
    }

    const storage = options.storage ?? new SqliteStorage(options.database);
    let runtime: Runtime | undefined;

    try {
        const controls = new WorldControls(storage, options);
        const useBuiltin =
            (options.modules?.length ?? 0) === 0 &&
            (setup
                ? !("database" in setup)
                : options.storage === undefined && options.database === undefined);

        if (setup && "database" in setup) {
            storage.restore(setup.database);
            controls.values.restore(setup.values);
        } else if (useBuiltin) {
            storage.restore(builtinDatabase());
        }

        const platform = new Platform(
            storage,
            { ...options, nextId: options.nextId ?? (() => controls.values.ids.item()) },
            new PlatformTrace((event) => controls.recorder.record(event)),
            () => controls.values.clock.now(),
            storage instanceof SqliteStorage ? storage[selectQuery].bind(storage) : undefined,
        );
        runtime = createRuntime({
            observer: controls.observer,
            transactions: storage.transactions,
            modules: [
                createPackageModule(storage),
                platform.module(),
                createFixtureModule(storage, () => controls.values.ids.fixture()),
                ...(options.modules ?? []),
            ],
        });

        if (setup && !("database" in setup)) {
            importConfiguredSetup(runtime, storage, setup, useBuiltin);
        } else if (!setup && !useBuiltin) {
            runtime.executeSync(importPackageDocuments, []);
        }

        const baseline = setup && "database" in setup ? setup.database : storage.snapshot();

        markCheckpoint(storage, baseline);

        if (setup && "database" in setup && storage instanceof SqliteStorage) {
            storage[retainCheckpoint](baseline);
        }

        return new HarnessInstance(storage, runtime, platform, controls, baseline);
    } catch (error) {
        throw combinedFailure("Engine initialization and cleanup failed.", [
            error,
            ...disposeResources(storage, runtime),
        ]);
    }
}

function importConfiguredSetup(
    runtime: Runtime,
    storage: HarnessStorage,
    setup: InitialSetup,
    useBuiltin: boolean,
): void {
    if (useBuiltin) {
        withImportBaseline(storage, builtinDatabase(), () =>
            runtime.executeSync(importSetupDocuments, setup),
        );
    } else {
        runtime.executeSync(importSetupDocuments, setup);
    }
}

function markCheckpoint(storage: HarnessStorage, image: Uint8Array): void {
    if (storage instanceof SqliteStorage) {
        storage[setCheckpoint](image);
    }
}

function resetCheckpoint(storage: HarnessStorage, image: Uint8Array): void {
    if (storage instanceof SqliteStorage && storage[restoreCheckpoint](image)) {
        return;
    }

    storage.restore(image);
    markCheckpoint(storage, image);
}

class HarnessInstance implements Engine {
    private closed = false;
    private packageReads = 0;
    readonly state: StateReader;
    readonly clock: ClockControl;

    constructor(
        readonly storage: HarnessStorage,
        readonly runtime: Runtime,
        private readonly platform: Platform,
        private readonly controls: WorldControls,
        private baseline: Uint8Array,
    ) {
        this.state = createStateReader(storage, () => this.assertReadable());
        this.clock = controls.values.clock.control(
            () => this.assertOpen(),
            () => this.assertIdle(),
        );
        controls.values.checkpoint();
    }

    get trace(): readonly PlatformTraceEvent[] {
        return this.platform.trace.read((requestId) => this.runtime.transactionOutcome(requestId));
    }

    capture(): EngineImage {
        this.assertIdle();

        if (this.storage instanceof SqliteStorage) {
            this.storage[retainCheckpoint](this.baseline);
        }

        return { database: this.baseline, values: this.controls.values.capture() };
    }

    get executions(): readonly ExecutionReport[] {
        return this.controls.recorder.executions;
    }

    observe(callback: ExecutionObserver): Observation {
        this.assertIdle();

        return this.controls.observers.add(callback);
    }

    injectFailure(injection: FailureInjection): InjectedFailureHandle {
        this.assertIdle();

        return this.controls.failures.add(injection);
    }

    clearExecutions(): void {
        this.assertIdle();
        this.controls.recorder.reset();
    }

    seed(type: string, properties: Readonly<Record<string, SeedValue>>): ItemReference {
        this.assertCallable();

        return this.runtime.executeSync(seedOperation, { type, properties });
    }

    inspect(reference: ItemReference): StoredItem {
        this.assertIdle();

        return this.platform.inspect(reference);
    }

    find(type: string, properties: Readonly<Record<string, StorageValue>>): ItemReference {
        this.assertIdle();

        // oxlint-disable-next-line unicorn/no-array-method-this-argument -- Platform record lookup.
        return this.platform.find(type, properties);
    }

    item(reference: ItemReference, action?: string): Item {
        this.assertIdle();

        return this.platform.item(reference, action);
    }

    apply(item: Item): Promise<Item> {
        return this.execute(() => this.runtime.execute(applyItemOperation, item.clone()));
    }

    applyAML(xml: string): Promise<Item> {
        return this.execute(() => this.runtime.execute(applyAMLOperation, xml));
    }

    callMethod(name: string, context: Item): Promise<Item> {
        return this.execute(() =>
            this.runtime.execute(callMethodOperation, {
                name,
                context: context.clone(),
            }),
        );
    }

    async loadPackages(paths: readonly string[]): Promise<PackageLoadReport> {
        this.assertCallable();
        this.packageReads += 1;

        try {
            const documents = await loadAmlDocuments(paths.map((path) => ({ path })));

            return await this.runtime.execute(importPackageDocuments, documents);
        } finally {
            this.packageReads -= 1;
        }
    }

    checkpoint(): void {
        this.assertIdle();
        const baseline = this.storage.snapshot();
        markCheckpoint(this.storage, baseline);
        this.baseline = baseline;
        this.controls.values.checkpoint();
    }

    reset(): void {
        this.assertIdle();

        try {
            this.runtime.reset();
            resetCheckpoint(this.storage, this.baseline);
            this.controls.values.reset();
        } catch (error) {
            this.closed = true;
            this.baseline = new Uint8Array();
            this.controls.close();

            throw combinedFailure("Engine reset and cleanup failed.", [
                error,
                ...disposeResources(this.storage, this.runtime),
            ]);
        }
    }

    close(): void {
        if (this.closed) {
            return;
        }

        this.assertIdle();
        this.closed = true;
        this.baseline = new Uint8Array();
        const failures = disposeResources(this.storage, this.runtime);
        this.controls.close();

        if (failures.length) {
            throw combinedFailure("Engine cleanup failed.", failures);
        }
    }

    [Symbol.dispose](): void {
        this.close();
    }

    private async execute(operation: () => Promise<Item>): Promise<Item> {
        this.assertCallable();

        try {
            return await operation();
        } catch (error) {
            if (error instanceof ApplicationError) {
                return error.item.clone();
            }

            throw error;
        }
    }

    private assertOpen(): void {
        if (this.closed) {
            throw new RuntimeError("RuntimeClosed", "The harness is closed.");
        }
    }

    private assertCallable(): void {
        this.assertOpen();

        if (this.controls.observers.isNotifying) {
            throw new RuntimeError(
                "WorldBusy",
                "Execution observers cannot reenter business operations.",
            );
        }
    }

    private assertReadable(): void {
        this.assertOpen();

        if (!this.controls.observers.isNotifying) {
            this.assertIdle();
        }
    }

    private assertIdle(): void {
        this.assertOpen();

        if (this.runtime.isBusy || this.packageReads > 0) {
            throw new RuntimeError(
                "WorldBusy",
                "Wait for active operations and package reads before changing the test baseline.",
            );
        }
    }
}

/** Both resources must be released even if a module's cleanup fails. */
function disposeResources(storage: HarnessStorage, runtime: Runtime | undefined): unknown[] {
    const failures: unknown[] = [];

    try {
        runtime?.close();
    } catch (error) {
        failures.push(error);
    }

    try {
        storage.close();
    } catch (error) {
        failures.push(error);
    }

    return failures;
}

function combinedFailure(message: string, failures: readonly unknown[]): unknown {
    if (failures.length === 1) {
        return failures[0];
    }

    return new AggregateError(failures, message);
}
