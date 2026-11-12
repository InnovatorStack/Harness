import { expect, test } from "bun:test";

import { assertDataTree, cloneData, getOwn, setOwn } from "../src/core/data.js";
import { Deadline } from "../src/core/deadline.js";
import { createRuntime, defineOperation } from "../src/core/index.js";
import type { ExecutionContext, RuntimeObserver, TransactionBoundary } from "../src/core/index.js";
import { dataDepthMax, requestDepthMax } from "../src/core/limits.js";
import { readProcessOutput } from "../src/core/process.js";
import { Item } from "../src/items/item.js";
import { encodeMessage, messageBytesMax, readMessages } from "../src/methods/csharp/protocol.js";
import { ItemLocks } from "../src/platform/locks.js";
import { PlatformTrace } from "../src/platform/trace.js";
import { SqliteStorage } from "../src/storage/sqlite/storage.js";

function statefulTransactions() {
    const state = { value: 0, before: 0 };
    const calls: string[] = [];
    const transactions: TransactionBoundary = {
        begin() {
            state.before = state.value;
            calls.push("begin");
        },

        commit() {
            calls.push("commit");
        },

        rollback() {
            state.value = state.before;
            calls.push("rollback");
        },
    };

    return { state, calls, transactions };
}

function observer(overrides: Partial<RuntimeObserver>): RuntimeObserver {
    return {
        started() {
            /* Default observer has no side effects. */
        },

        completed() {
            /* Default observer has no side effects. */
        },

        failed() {
            /* Default observer has no side effects. */
        },

        settled() {
            /* Default observer has no side effects. */
        },

        reset() {
            /* Default observer has no side effects. */
        },

        ...overrides,
    };
}

test("a completion observer failure rolls back before commit", () => {
    const fixture = statefulTransactions();
    const operation = defineOperation<void, number>("write");
    const failure = new Error("Observer failed");
    const runtime = createRuntime({
        transactions: fixture.transactions,
        observer: observer({
            completed() {
                throw failure;
            },
        }),
        modules: [
            {
                id: "write",

                setup(registrar) {
                    registrar.handleSync(operation, () => {
                        fixture.state.value = 9;

                        return 9;
                    });
                },
            },
        ],
    });

    expect(() => runtime.executeSync(operation, undefined)).toThrow(failure);
    expect(fixture.state.value).toBe(0);
    expect(fixture.calls).toEqual(["begin", "rollback"]);
    expect(runtime.isBusy).toBe(false);
    runtime.close();
});

test("settlement observation cannot leave a committed runtime busy", () => {
    const fixture = statefulTransactions();
    const operation = defineOperation<void, number>("write");
    let fail = true;
    const runtime = createRuntime({
        transactions: fixture.transactions,
        observer: observer({
            settled() {
                if (fail) {
                    fail = false;

                    throw new Error("Settlement failed");
                }
            },
        }),
        modules: [
            {
                id: "write",

                setup(registrar) {
                    registrar.handleSync(operation, () => {
                        fixture.state.value += 1;

                        return 1;
                    });
                },
            },
        ],
    });

    expect(() => runtime.executeSync(operation, undefined)).toThrow("Settlement failed");
    expect(fixture.state.value).toBe(1);
    expect(runtime.transactionOutcome("1")).toBe("committed");
    expect(runtime.isBusy).toBe(false);
    expect(runtime.executeSync(operation, undefined)).toBe(1);
    runtime.close();
});

test("a detached child that never resolves cannot delay rollback", async () => {
    const fixture = statefulTransactions();
    const child = defineOperation<void, void>("never-finishes");
    const root = defineOperation<void, void>("root");
    const runtime = createRuntime({
        transactions: fixture.transactions,
        modules: [
            {
                id: "async",

                setup(registrar) {
                    registrar.handleAsync(
                        child,
                        () =>
                            new Promise(() => {
                                // Deliberately never settle this extension-owned Promise.
                            }),
                    );
                    registrar.handleAsync(root, (_, context) => {
                        fixture.state.value = 9;
                        void context.execute(child, undefined);

                        return Promise.resolve();
                    });
                },
            },
        ],
    });

    await expect(runtime.execute(root, undefined)).rejects.toMatchObject({
        code: "UnfinishedExecution",
    });
    expect(fixture.state.value).toBe(0);
    expect(runtime.isBusy).toBe(false);
    runtime.close();
}, 1000);

test("caught recursive dispatch still poisons and rolls back the request", () => {
    const fixture = statefulTransactions();
    const operation = defineOperation<void, number>("nested");
    let attempted = 0;
    const runtime = createRuntime({
        transactions: fixture.transactions,
        modules: [
            {
                id: "nested",

                setup(registrar) {
                    registrar.handleSync(operation, (_, context) => {
                        attempted += 1;
                        fixture.state.value += 1;

                        try {
                            return context.executeSync(operation, undefined);
                        } catch {
                            return 42;
                        }
                    });
                },
            },
        ],
    });

    expect(() => runtime.executeSync(operation, undefined)).toThrow("nesting or operation limit");
    expect(attempted).toBe(requestDepthMax);
    expect(fixture.state.value).toBe(0);
    runtime.close();
});

test("a saved execution context cannot write after its request completes", () => {
    const fixture = statefulTransactions();
    const operation = defineOperation<void, number>("write");
    let saved: ExecutionContext | undefined;
    const runtime = createRuntime({
        transactions: fixture.transactions,
        modules: [
            {
                id: "write",

                setup(registrar) {
                    registrar.handleSync(operation, (_, context) => {
                        saved = context;

                        return 1;
                    });
                },
            },
        ],
    });
    runtime.executeSync(operation, undefined);

    if (!saved) {
        throw new Error("The handler did not capture its execution context.");
    }

    const expired = saved;
    expect(() => expired.executeSync(operation, undefined)).toThrow("no longer active");
    expect(fixture.calls).toEqual(["begin", "commit"]);
    runtime.close();
});

test("bounded data rejects cycles, sparse arrays and accessors without evaluating getters", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => cloneData(circular)).toThrow("circular");
    let reads = 0;
    const input = {
        get value() {
            reads += 1;

            return "unexpected";
        },
    };
    expect(() => assertDataTree(input)).toThrow("accessors");
    expect(reads).toBe(0);
    // A sparse array is deliberately invalid input to the data boundary.
    // oxlint-disable-next-line unicorn/no-new-array
    const sparse = new Array(2);
    Object.defineProperty(sparse, "custom", { value: 1, enumerable: true });
    expect(() => assertDataTree(sparse)).toThrow();
    const values: Record<string, string> = {};
    setOwn(values, "__proto__", "source value");
    setOwn(values, "constructor", "another source value");
    expect(getOwn(cloneData(values), "__proto__")).toBe("source value");
    expect(Object.getPrototypeOf(values)).toBe(Object.prototype);
});

test("deep data fails at the declared boundary instead of exhausting the native stack", () => {
    const root: Record<string, unknown> = {};
    let current = root;

    for (let depth = 0; depth <= dataDepthMax; depth += 1) {
        const next: Record<string, unknown> = {};
        current.child = next;
        current = next;
    }

    expect(() => cloneData(root)).toThrow("nesting limit");
});

test("deadlines settle abandoned work and enforce the native timer range", async () => {
    expect(() => new Deadline(2_147_483_648, () => new Error("timeout"))).toThrow();
    using deadline = new Deadline(5, () => new Error("Abandoned work expired"));
    await expect(
        deadline.wait(
            new Promise(() => {
                // Simulate an external adapter which never settles.
            }),
        ),
    ).rejects.toThrow("Abandoned work expired");
});

test("the managed byte budget applies per message rather than per pipe chunk", async () => {
    const bytes = new TextEncoder().encode(
        `${JSON.stringify({ kind: "result", id: "1", text: "x".repeat(messageBytesMax / 2) })}\n`,
    );
    const messages: unknown[] = [];
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            const chunk = new Uint8Array(bytes.length * 2);
            chunk.set(bytes);
            chunk.set(bytes, bytes.length);
            controller.enqueue(chunk);
            controller.close();
        },
    });
    await readMessages(stream, (message) => {
        messages.push(message);
    });
    expect(messages).toHaveLength(2);
    expect(() => encodeMessage({ text: "x".repeat(messageBytesMax) })).toThrow("8 MiB");
});

test("process diagnostics retain a fixed prefix and explicitly mark truncation", async () => {
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            for (let index = 0; index < 20; index += 1) {
                controller.enqueue(new Uint8Array(100_000).fill(120));
            }

            controller.close();
        },
    });
    const output = await readProcessOutput(stream);
    expect(output.startsWith("xxx")).toBe(true);
    expect(output).toContain("output truncated");
    expect(output.length).toBeLessThan(1_049_000);
});

test("managed transport rejects malformed UTF-8 and incomplete messages", async () => {
    const malformed = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new Uint8Array([255, 10]));
            controller.close();
        },
    });
    await expect(
        readMessages(malformed, () => {
            throw new Error("Malformed text must not reach the receiver.");
        }),
    ).rejects.toThrow();
    const unfinished = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new TextEncoder().encode('{"kind":"result","id":"1"}'));
            controller.close();
        },
    });
    await expect(
        readMessages(unfinished, () => {
            throw new Error("Unframed data must not reach the receiver.");
        }),
    ).rejects.toThrow("inside a message");
});

function deferred() {
    let finish: (() => void) | undefined;
    const promise = new Promise<void>((resolve) => {
        finish = resolve;
    });

    return {
        promise,

        release() {
            if (!finish) {
                throw new Error("The deferred Promise is not initialized.");
            }

            finish();
        },
    };
}

test("a lock hook resumed after rollback cannot write outside the expired transaction", async () => {
    const storage = new SqliteStorage();
    const definition = {
        id: "DOCUMENT",
        name: "Document",
        properties: [
            { name: "locked_by_id", dataType: "string" },
            { name: "new_version", dataType: "integer" },
        ],
    };
    storage.defineItemType(definition);
    const record = {
        type: "Document",
        id: "ONE",
        properties: { locked_by_id: null, new_version: 1 },
    };
    storage.insertItem(record);
    const entered = deferred();
    const resume = deferred();
    const locks = new ItemLocks(
        storage,
        new PlatformTrace(),
        (_type, event) => {
            if (event === "onBeforeLock") {
                entered.release();

                return resume.promise;
            }

            return Promise.resolve();
        },
        () => "USER",
        () => {
            throw new Error("This test exercises the native lock implementation directly.");
        },
    );
    const request = Item.create("Document", "lock");
    request.setProperty("id", record.id);
    const child = defineOperation<void, void>("lock");
    const root = defineOperation<void, void>("detached-lock");
    const runtime = createRuntime({
        transactions: storage.transactions,
        modules: [
            {
                id: "locks",

                setup(registrar) {
                    registrar.handleAsync(child, async (_, context) => {
                        await locks.base(definition, record, "lock", context, request);
                    });
                    registrar.handleAsync(root, async (_, context) => {
                        void context.execute(child, undefined);
                        await entered.promise;
                    });
                },
            },
        ],
    });

    await expect(runtime.execute(root, undefined)).rejects.toMatchObject({
        code: "UnfinishedExecution",
    });
    resume.release();
    await Bun.sleep(5);
    expect(storage.getItem("Document", "ONE")?.properties.locked_by_id).toBeNull();
    runtime.close();
    storage.close();
});

test("managed and Bun transport budgets remain aligned", async () => {
    const source = await Bun.file(
        new URL("../src/methods/csharp/managed/WorkLimits.cs", import.meta.url),
    ).text();
    expect(source).toContain(`DepthMax = ${dataDepthMax};`);
    expect(source).toContain("MessageBytesMax = 8 * 1024 * 1024;");
    expect(messageBytesMax).toBe(8 * 1024 * 1024);
});
