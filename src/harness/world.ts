import type { ClockControl } from "../controls/clock.js";
import type { FailureInjection, InjectedFailureHandle } from "../controls/failure-types.js";
import type { ExecutionObserver, Observation } from "../controls/observers.js";
import type { StateReader } from "../controls/state.js";
import { dataDepthMax, dataNodesMax } from "../core/limits.js";
import type { Engine } from "../engine.js";
import type { ExecutionReport } from "../instrumentation/types.js";
import { Item } from "../items/item.js";
import type { ItemNode } from "../items/item.js";
import { PlatformError } from "../platform/errors.js";
import type { PlatformTraceEvent } from "../platform/trace.js";
import type { StorageValue, StoredItem } from "../storage/types.js";

export type Properties = Readonly<Record<string, StorageValue>>;

export interface MethodParameters {
    readonly [name: string]: StorageValue | Item | MethodParameters;
}

/** An isolated, configured test world. Creation and fixture setup are complete. */
export class Harness implements Disposable {
    constructor(private readonly engine: Engine) {}

    get state(): StateReader {
        return this.engine.state;
    }

    get clock(): ClockControl {
        return this.engine.clock;
    }

    observe(callback: ExecutionObserver): Observation {
        return this.engine.observe(callback);
    }

    injectFailure(injection: FailureInjection): InjectedFailureHandle {
        return this.engine.injectFailure(injection);
    }

    get trace(): readonly PlatformTraceEvent[] {
        return this.engine.trace;
    }

    get executions(): readonly ExecutionReport[] {
        return this.engine.executions;
    }

    clearExecutions(): void {
        this.engine.clearExecutions();
    }

    async get(type: string, selector: Properties = {}): Promise<readonly StoredItem[]> {
        const query = Item.create(type, "get");
        setProperties(query, selector);
        const result = await this.engine.apply(query);

        if (result.isError() && result.getErrorCode() === "0") {
            return [];
        }

        assertSuccess(result);

        return result.payload.items.map(toRecord);
    }

    async getOne(type: string, selector: Properties): Promise<StoredItem> {
        const records = await this.get(type, selector);
        const record = records[0];

        if (records.length !== 1 || !record) {
            throw new PlatformError(
                "ItemResolution",
                `Expected one '${type}' record; found ${records.length}.`,
            );
        }

        return record;
    }

    async add(type: string, properties: Properties): Promise<StoredItem> {
        const request = Item.create(type, "add");
        setProperties(request, properties);

        return toRecord(assertSuccess(await this.engine.apply(request)).node);
    }

    async update(record: StoredItem, changes: Properties): Promise<StoredItem> {
        const request = Item.create(record.type, "edit");
        request.setProperty("id", record.id);
        setProperties(request, changes);

        return toRecord(assertSuccess(await this.engine.apply(request)).node);
    }

    async delete(record: StoredItem): Promise<void> {
        const request = Item.create(record.type, "delete");
        request.setProperty("id", record.id);
        assertSuccess(await this.engine.apply(request));
    }

    async callMethod(name: string, parameters: MethodParameters | Item = {}): Promise<Item> {
        if (parameters instanceof Item) {
            return await this.engine.callMethod(name, parameters);
        }

        const context = Item.create("Method", name);
        setMethodParameters(context, parameters, new Set());

        return await this.engine.callMethod(name, context);
    }

    applyAML(xml: string): Promise<Item> {
        return this.engine.applyAML(xml);
    }

    reset(): void {
        this.engine.reset();
    }

    close(): void {
        this.engine.close();
    }

    [Symbol.dispose](): void {
        this.close();
    }
}

function setMethodParameters(
    item: Item,
    parameters: MethodParameters,
    ancestors: Set<MethodParameters>,
): void {
    interface Frame {
        readonly item: Item;
        readonly input: MethodParameters;
        readonly entries: [string, MethodParameters[string]][];
        next: number;
    }

    const pending: Frame[] = [
        { item, input: parameters, entries: parameterEntries(parameters), next: 0 },
    ];
    ancestors.add(parameters);
    let visited = 0;

    while (pending.length > 0) {
        const frame = pending.at(-1);

        if (!frame) {
            throw new Error("A parameter frame must exist while traversal is pending.");
        }

        const entry = frame.entries[frame.next];

        if (!entry) {
            ancestors.delete(frame.input);
            pending.pop();
            continue;
        }

        frame.next += 1;
        visited += 1;

        if (visited > dataNodesMax || pending.length > dataDepthMax) {
            throw new TypeError("Method parameters exceed their node or nesting limit.");
        }

        const [name, value] = entry;

        if (value instanceof Item) {
            frame.item.setPropertyItem(name, value.clone());
        } else if (value !== null && typeof value === "object") {
            if (ancestors.has(value)) {
                throw new TypeError("Method parameters cannot contain circular references.");
            }

            const nested = Item.create("");
            frame.item.setPropertyItem(name, nested);
            ancestors.add(value);
            pending.push({ item: nested, input: value, entries: parameterEntries(value), next: 0 });
        } else if (
            value === null ||
            typeof value === "string" ||
            (typeof value === "number" && Number.isFinite(value))
        ) {
            frame.item.setProperty(name, value);
        } else {
            throw new TypeError(`Invalid Method parameter '${name}'.`);
        }
    }
}

function parameterEntries(parameters: MethodParameters): [string, MethodParameters[string]][] {
    if (
        parameters === null ||
        typeof parameters !== "object" ||
        Array.isArray(parameters) ||
        !isPlainObject(parameters)
    ) {
        throw new TypeError("Method parameters must contain Item properties.");
    }

    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(parameters))) {
        if (descriptor.get || descriptor.set) {
            throw new TypeError("Method parameters cannot contain accessors.");
        }
    }

    return Object.entries(parameters);
}

function setProperties(item: Item, properties: Properties): void {
    for (const [name, value] of Object.entries(properties)) {
        item.setProperty(name, value);
    }
}

function toRecord(node: ItemNode): StoredItem {
    const id = node.attributes.id;

    if (!id) {
        throw new PlatformError(
            "InvalidActionResult",
            "The action did not return a persisted record ID.",
        );
    }

    return {
        id,
        type: node.type,
        properties: { ...node.properties },
    };
}

function assertSuccess(result: Item): Item {
    if (result.isError()) {
        throw new PlatformError(result.getErrorCode(), result.getErrorString());
    }

    return result;
}

function isPlainObject(value: object): boolean {
    const prototype: unknown = Object.getPrototypeOf(value);

    return prototype === Object.prototype || prototype === null;
}
