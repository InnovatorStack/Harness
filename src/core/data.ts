import { dataBytesMax, dataDepthMax, dataNodesMax } from "./limits.js";

interface DataFrame {
    readonly value: unknown;
    readonly depth: number;
    readonly leaving?: boolean;
}

interface DataOptions {
    readonly allowArrays: boolean;
    readonly allowUndefined: boolean;
}

const frozenData = new WeakSet();

export function isFrozenData(value: unknown): boolean {
    return value !== null && typeof value === "object" && frozenData.has(value);
}

/** Validate before native cloning/serialization, which can otherwise overflow on deep input. */
export function assertDataTree(
    value: unknown,
    options = { allowArrays: true, allowUndefined: true },
): void {
    if (options.allowArrays && options.allowUndefined && isFrozenData(value)) {
        return;
    }

    new DataValidator(options).validate(value);
}

/** JSON.parse owns every property, so this boundary does not need accessor/prototype inspection. */
export function parseFrozenJson(text: string): unknown {
    const value: unknown = JSON.parse(text);
    const targets: object[] = [];
    new DataValidator({ allowArrays: true, allowUndefined: false }, true).validate(value, targets);

    for (const target of targets) {
        Object.freeze(target);
        frozenData.add(target);
    }

    return value;
}

class DataValidator {
    private readonly pending: DataFrame[] = [];
    private readonly ancestors = new Set<object>();
    private nodes = 0;
    private bytes = 0;

    constructor(
        private readonly options: DataOptions,
        private readonly parsedJson = false,
    ) {}

    validate(value: unknown, freezeTargets?: object[]): void {
        this.pending.push({ value, depth: 0 });

        while (this.pending.length > 0) {
            const frame = this.pending.pop();

            if (!frame) {
                throw new Error("A data frame must exist while traversal is pending.");
            }

            if (frame.leaving && frame.value !== null && typeof frame.value === "object") {
                this.ancestors.delete(frame.value);

                freezeTargets?.push(frame.value);

                continue;
            }

            this.nodes += 1;

            if (this.nodes > dataNodesMax || frame.depth > dataDepthMax) {
                throw new TypeError("Data exceeds the supported node or nesting limit.");
            }

            if (frame.value === undefined && !this.options.allowUndefined) {
                throw new TypeError("Data cannot contain undefined values.");
            }

            this.addBytes(scalarBytes(frame.value));

            if (frame.value !== null && typeof frame.value === "object") {
                if (this.parsedJson) {
                    this.enterParsedObject(frame.value, frame.depth);
                } else {
                    this.enterObject(frame.value, frame.depth, freezeTargets !== undefined);
                }
            }
        }
    }

    private enterParsedObject(value: object, depth: number): void {
        this.pending.push({ value, depth, leaving: true });

        for (const [name, child] of Object.entries(value)) {
            this.addBytes(name.length * 3);

            if (this.pending.length >= dataNodesMax) {
                throw new TypeError("Data exceeds the supported node limit.");
            }

            this.pending.push({ value: child, depth: depth + 1 });
        }
    }

    private enterObject(value: object, depth: number, freezing: boolean): void {
        if (Array.isArray(value) && !this.options.allowArrays) {
            throw new TypeError("Data cannot contain arrays.");
        }

        if (Object.getOwnPropertySymbols(value).length > 0) {
            throw new TypeError("Data cannot contain symbol properties.");
        }

        if (this.ancestors.has(value)) {
            throw new TypeError("Data cannot contain circular references.");
        }

        const prototype: unknown = Object.getPrototypeOf(value);

        if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
            throw new TypeError("Data must contain plain objects and arrays.");
        }

        this.ancestors.add(value);
        this.pending.push({ value, depth, leaving: true });
        const entries = Object.entries(Object.getOwnPropertyDescriptors(value));
        let arrayIndexCount = 0;

        for (const [name, descriptor] of entries) {
            if (freezing && (descriptor.get || descriptor.set)) {
                throw new TypeError("Data cannot contain accessors.");
            }

            if (!descriptor.enumerable) {
                continue;
            }

            if (descriptor.get || descriptor.set) {
                throw new TypeError("Data cannot contain accessors.");
            }

            if (Array.isArray(value)) {
                if (!/^(0|[1-9][0-9]*)$/.test(name) || Number(name) >= value.length) {
                    throw new TypeError("Data arrays must contain only indexed values.");
                }

                arrayIndexCount += 1;
            }

            this.addBytes(name.length * 3);

            if (this.pending.length >= dataNodesMax) {
                throw new TypeError("Data exceeds the supported node limit.");
            }

            const child: unknown = descriptor.value;
            this.pending.push({ value: child, depth: depth + 1 });
        }

        if (Array.isArray(value) && arrayIndexCount !== value.length) {
            throw new TypeError("Data arrays must be dense.");
        }
    }

    private addBytes(bytes: number): void {
        this.bytes += bytes;

        if (this.bytes > dataBytesMax) {
            throw new TypeError("Data exceeds the supported byte limit.");
        }
    }
}

function scalarBytes(value: unknown): number {
    if (value === null || value === undefined || typeof value === "boolean") {
        return 5;
    }

    if (typeof value === "string") {
        return value.length * 3 + 2;
    }

    if (typeof value === "number" && Number.isFinite(value)) {
        return 24;
    }

    if (typeof value === "object") {
        return 2;
    }

    throw new TypeError("Data contains a non-serializable value.");
}

export function cloneData<Value>(value: Value): Value {
    if (!isFrozenData(value)) {
        assertDataTree(value);
    }

    return structuredClone(value);
}

/** Validate at the boundary, then freeze the detached native copy without revalidating it. */
export function cloneFrozenData<Value>(value: Value): Value {
    const copied = cloneData(value);
    const pending: unknown[] = [copied];
    const visited = new Set<object>();

    while (pending.length > 0) {
        const current = pending.pop();

        if (current === null || typeof current !== "object" || visited.has(current)) {
            continue;
        }

        visited.add(current);

        if (visited.size > dataNodesMax) {
            throw new Error("A validated clone cannot exceed its source node budget.");
        }

        for (const child of Object.values(current)) {
            pending.push(child);
        }

        Object.freeze(current);
        frozenData.add(current);
    }

    return copied;
}

/** Freeze only data properties; never evaluate a user getter while recording diagnostics. */
export function freezeData<Value>(value: Value): Value {
    if (isFrozenData(value)) {
        return value;
    }

    const targets: object[] = [];
    new DataValidator({ allowArrays: true, allowUndefined: true }).validate(value, targets);

    for (const target of targets) {
        Object.freeze(target);
        frozenData.add(target);
    }

    return value;
}

export function setOwn<Value>(record: Record<string, Value>, name: string, value: Value): void {
    Object.defineProperty(record, name, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
    });
}

export function getOwn<Value>(
    record: Readonly<Record<string, Value>>,
    name: string,
): Value | undefined {
    if (!Object.hasOwn(record, name)) {
        return undefined;
    }

    return record[name];
}
