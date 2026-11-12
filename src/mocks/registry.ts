import { assertDataTree, cloneData, getOwn, setOwn } from "../core/data.js";
import type { Item } from "../items/item.js";
import type { PreparedResponse } from "./response.js";
import type { Mock, MockValue } from "./types.js";

export interface PreparedMock {
    readonly kind: "method" | "sql";
    readonly name: string | true;
    readonly when: Readonly<Record<string, MockValue>>;
    readonly response: PreparedResponse;
    readonly definition: string;
    readonly layer: number;
}

export interface MockMatch {
    readonly result: Item;
    readonly definition: string;
    readonly responseFile?: string;
    readonly responseHash: string;
    readonly parameters: Readonly<Record<string, MockValue>>;
}

export interface MockDescription {
    readonly definition: string;
    readonly when: Readonly<Record<string, MockValue>>;
    readonly layer: number;
    readonly responseFile?: string;
    readonly responseHash: string;
}

/** Immutable response definitions; every invocation receives its own Item. */
export class MockRegistry {
    constructor(private readonly mocks: readonly PreparedMock[]) {}

    /** Describe matching targets without selecting a response for invented parameters. */
    describe(kind: PreparedMock["kind"], names: readonly string[]): readonly MockDescription[] {
        return Object.freeze(
            this.mocks
                .filter(
                    (mock) => mock.kind === kind && names.some((name) => sameName(name, mock.name)),
                )
                .map((mock) =>
                    Object.freeze({
                        definition: mock.definition,
                        when: cloneData(mock.when),
                        layer: mock.layer,
                        responseHash: mock.response.hash,
                        ...(mock.response.file ? { responseFile: mock.response.file } : {}),
                    }),
                ),
        );
    }

    method(names: readonly string[], item: Item): MockMatch | undefined {
        const matches = this.mocks.some(
            (mock) => mock.kind === "method" && names.some((name) => sameName(name, mock.name)),
        );

        if (!matches) {
            return undefined;
        }

        return this.find("method", names, properties(item));
    }

    sql(name: string | true, values: Readonly<Record<string, MockValue>>): MockMatch | undefined {
        return this.find("sql", [name], values);
    }

    private find(
        kind: PreparedMock["kind"],
        names: readonly (string | true)[],
        values: Readonly<Record<string, MockValue>>,
    ): MockMatch | undefined {
        const candidates = this.mocks.filter(
            (mock) =>
                mock.kind === kind &&
                names.some((name) => sameName(name, mock.name)) &&
                matchesParameters(mock.when, values),
        );

        if (candidates.length === 0) {
            return undefined;
        }

        const layer = candidates.reduce(
            (highest, mock) => Math.max(highest, mock.layer),
            -Infinity,
        );
        const current = candidates.filter((mock) => mock.layer === layer);
        const specificity = current.reduce(
            (highest, mock) => Math.max(highest, weight(mock.when)),
            0,
        );
        const selected = current.filter((mock) => weight(mock.when) === specificity);
        const mock = selected[0];

        if (selected.length !== 1 || !mock) {
            throw new Error(
                `Ambiguous ${kind} mocks for '${names.join(" / ")}': ${selected.map((mock) => mock.definition).join(", ")}.`,
            );
        }

        return {
            result: mock.response.item.clone(),
            definition: mock.definition,
            responseHash: mock.response.hash,
            parameters: cloneData(values),
            ...(mock.response.file ? { responseFile: mock.response.file } : {}),
        };
    }
}

export function properties(item: Item): Readonly<Record<string, MockValue>> {
    if (item.payload.items.length !== 1 || item.isError()) {
        return {};
    }

    assertDataTree(item.payload);
    const result: Record<string, MockValue> = {};
    const pending = [{ node: item.node, output: result }];

    while (pending.length > 0) {
        const frame = pending.pop();

        if (!frame) {
            throw new Error("A mock parameter frame must exist while traversal is pending.");
        }

        for (const [name, value] of Object.entries(frame.node.properties)) {
            setOwn(frame.output, name, value);
        }

        setOwn(frame.output, "id", frame.node.attributes.id ?? "");

        for (const [name, node] of Object.entries(frame.node.propertyItems)) {
            const output: Record<string, MockValue> = {};
            setOwn(frame.output, name, output);
            pending.push({ node, output });
        }
    }

    return result;
}

export function matchesParameters(
    expected: Readonly<Record<string, MockValue>>,
    actual: Readonly<Record<string, MockValue>>,
): boolean {
    const pending = [{ expected, actual }];

    while (pending.length > 0) {
        const frame = pending.pop();

        if (!frame) {
            throw new Error("A mock match frame must exist while traversal is pending.");
        }

        for (const [name, value] of Object.entries(frame.expected)) {
            const candidate = getOwn(frame.actual, name);

            if (value !== null && typeof value === "object") {
                if (candidate === null || typeof candidate !== "object") {
                    return false;
                }

                pending.push({ expected: value, actual: candidate });
            } else if (candidate === undefined || candidate !== value) {
                return false;
            }
        }
    }

    return true;
}

function sameName(left: string | true, right: string | true): boolean {
    if (typeof left === "string" && typeof right === "string") {
        return left.toLowerCase() === right.toLowerCase();
    }

    return left === right;
}

function weight(when: Readonly<Record<string, MockValue>>): number {
    let total = 0;
    const pending = [when];

    while (pending.length > 0) {
        const current = pending.pop();

        if (!current) {
            throw new Error("A mock weight frame must exist while traversal is pending.");
        }

        for (const value of Object.values(current)) {
            total += 1;

            if (value !== null && typeof value === "object") {
                pending.push(value);
            }
        }
    }

    return total;
}

export function mockTarget(mock: Mock): Pick<PreparedMock, "kind" | "name"> {
    if (mock.method !== undefined) {
        return { kind: "method", name: mock.method };
    }

    return { kind: "sql", name: mock.sql };
}
