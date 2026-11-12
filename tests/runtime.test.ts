import { describe, expect, test } from "bun:test";

import { createRuntime, defineOperation, RuntimeError } from "../src/core/index.js";
import type { ExecutionContext, HarnessModule, TransactionBoundary } from "../src/core/index.js";

function testTransactions() {
    const state = { value: 0 };
    const calls: string[] = [];
    let before: number | undefined;
    const transactions: TransactionBoundary = {
        begin() {
            if (before !== undefined) {
                throw new Error("Transaction already active.");
            }

            calls.push("begin");
            before = state.value;
        },

        commit() {
            if (before === undefined) {
                throw new Error("No transaction.");
            }

            calls.push("commit");
            before = undefined;
        },

        rollback() {
            if (before === undefined) {
                throw new Error("No transaction.");
            }

            calls.push("rollback");
            state.value = before;
            before = undefined;
        },
    };

    return { state, calls, transactions };
}

function gate() {
    let release: (() => void) | undefined;
    const promise = new Promise<void>((resolve) => {
        release = resolve;
    });

    return {
        promise,

        release() {
            if (!release) {
                throw new Error("Gate is not initialized.");
            }

            release();
        },
    };
}

function expectRuntimeError(action: () => unknown, code: RuntimeError["code"]): void {
    try {
        action();

        throw new Error(`Expected ${code}.`);
    } catch (error) {
        expect(error).toBeInstanceOf(RuntimeError);

        if (!(error instanceof RuntimeError)) {
            throw error;
        }

        expect(error.code).toBe(code);
    }
}

describe("modular runtime", () => {
    test("nested operations share one transaction and record their parent", () => {
        const fixture = testTransactions();
        const increment = defineOperation<number, number>("increment");
        const twice = defineOperation<number, number>("twice");
        const runtime = createRuntime({
            transactions: fixture.transactions,
            modules: [
                {
                    id: "math",

                    setup(registrar) {
                        registrar.handleSync(
                            increment,
                            (amount) => (fixture.state.value += amount),
                        );
                        registrar.handleSync(twice, (amount, context) => {
                            context.executeSync(increment, amount);

                            return context.executeSync(increment, amount);
                        });
                    },
                },
            ],
        });

        expect(runtime.executeSync(twice, 3)).toBe(6);
        expect(fixture.calls).toEqual(["begin", "commit"]);
        expect(
            runtime.trace.map((event) => [event.operation, event.phase, event.parentExecutionId]),
        ).toEqual([
            ["twice", "start", undefined],
            ["increment", "start", "1"],
            ["increment", "success", "1"],
            ["increment", "start", "1"],
            ["increment", "success", "1"],
            ["twice", "success", undefined],
        ]);
        expect(Object.isFrozen(runtime.trace)).toBe(true);
        expect(Object.isFrozen(runtime.trace[0])).toBe(true);
        runtime.close();
    });

    test("validates the entire module graph before setup", () => {
        const fixture = testTransactions();
        let setups = 0;
        const module = (id: string, requires: readonly string[] = []): HarnessModule => ({
            id,
            requires,

            setup() {
                setups += 1;
            },
        });
        expectRuntimeError(
            () =>
                createRuntime({
                    transactions: fixture.transactions,
                    modules: [module("a"), module("a")],
                }),
            "DuplicateModule",
        );
        expectRuntimeError(
            () =>
                createRuntime({
                    transactions: fixture.transactions,
                    modules: [module("a"), module("b", ["missing"])],
                }),
            "MissingModule",
        );
        expectRuntimeError(
            () =>
                createRuntime({
                    transactions: fixture.transactions,
                    modules: [module("a", ["b"]), module("b", ["a"])],
                }),
            "ModuleCycle",
        );
        expect(setups).toBe(0);
    });

    test("orders dependencies and disposes in reverse order after setup failure", () => {
        const fixture = testTransactions();
        const actions: string[] = [];
        const operation = defineOperation<void, void>("shared");
        const modules: HarnessModule[] = [
            {
                id: "dependent",
                requires: ["base"],

                setup(registrar) {
                    actions.push("dependent.setup");
                    registrar.handleSync(operation, () => {});
                },

                dispose() {
                    actions.push("dependent.dispose");
                },
            },
            {
                id: "base",

                setup(registrar) {
                    actions.push("base.setup");
                    registrar.handleSync(operation, () => {});
                },

                dispose() {
                    actions.push("base.dispose");
                },
            },
        ];
        expectRuntimeError(
            () => createRuntime({ transactions: fixture.transactions, modules }),
            "DuplicateOperation",
        );
        expect(actions).toEqual([
            "base.setup",
            "dependent.setup",
            "dependent.dispose",
            "base.dispose",
        ]);
    });

    test("unknown operations poison the request even when a handler catches the error", () => {
        const fixture = testTransactions();
        const outer = defineOperation<void, void>("outer");
        const missing = defineOperation<void, void>("missing");
        const runtime = createRuntime({
            transactions: fixture.transactions,
            modules: [
                {
                    id: "test",

                    setup(registrar) {
                        registrar.handleSync(outer, (_, context) => {
                            fixture.state.value = 5;

                            try {
                                context.executeSync(missing, undefined);
                            } catch {
                                // Catching the error must not prevent rollback.
                            }
                        });
                    },
                },
            ],
        });

        expectRuntimeError(() => runtime.executeSync(outer, undefined), "UnknownOperation");
        expect(fixture.state.value).toBe(0);
        expect(fixture.calls).toEqual(["begin", "rollback"]);
        expect(runtime.trace.at(-1)?.phase).toBe("failure");
        runtime.close();
    });

    test("rejects async crossings before invoking the async handler", () => {
        const fixture = testTransactions();
        const outer = defineOperation<void, void>("outer");
        const asynchronous = defineOperation<void, void>("asynchronous");
        let asynchronousCalls = 0;
        const runtime = createRuntime({
            transactions: fixture.transactions,
            modules: [
                {
                    id: "test",

                    setup(registrar) {
                        registrar.handleSync(outer, (_, context) => {
                            fixture.state.value = 5;
                            context.executeSync(asynchronous, undefined);
                        });
                        registrar.handleAsync(asynchronous, async () => {
                            asynchronousCalls += 1;
                        });
                    },
                },
            ],
        });

        expectRuntimeError(
            () => runtime.executeSync(outer, undefined),
            "AsyncOperationInSyncExecution",
        );
        expect(asynchronousCalls).toBe(0);
        expect(fixture.state.value).toBe(0);
        runtime.close();
    });

    test("serializes top-level async requests including reads and rejects synchronous interference", async () => {
        const fixture = testTransactions();
        const started = gate();
        const complete = gate();
        const write = defineOperation<void, void>("write");
        const read = defineOperation<void, number>("read");
        let reads = 0;
        const runtime = createRuntime({
            transactions: fixture.transactions,
            modules: [
                {
                    id: "test",

                    setup(registrar) {
                        registrar.handleAsync(write, async () => {
                            fixture.state.value = 8;
                            started.release();
                            await complete.promise;
                        });
                        registrar.handleSync(read, () => {
                            reads += 1;

                            return fixture.state.value;
                        });
                    },
                },
            ],
        });

        const writing = runtime.execute(write, undefined);
        expect(runtime.isBusy).toBe(true);
        expectRuntimeError(() => runtime.executeSync(read, undefined), "WorldBusy");
        await started.promise;
        const reading = runtime.execute(read, undefined);
        expectRuntimeError(() => runtime.reset(), "WorldBusy");
        expectRuntimeError(() => runtime.close(), "WorldBusy");
        expect(reads).toBe(0);
        complete.release();
        await writing;
        expect(await reading).toBe(8);
        expect(fixture.calls).toEqual(["begin", "commit", "begin", "commit"]);
        expect(runtime.isBusy).toBe(false);
        runtime.close();
    });

    test("nested async execution reenters its transaction and can call synchronous operations", async () => {
        const fixture = testTransactions();
        const outer = defineOperation<number, number>("outer");
        const inner = defineOperation<number, number>("inner");
        const increment = defineOperation<number, number>("increment");
        const runtime = createRuntime({
            transactions: fixture.transactions,
            modules: [
                {
                    id: "test",

                    setup(registrar) {
                        registrar.handleSync(increment, (value) => (fixture.state.value += value));
                        registrar.handleAsync(inner, async (value, context) =>
                            context.executeSync(increment, value),
                        );
                        registrar.handleAsync(
                            outer,
                            async (value, context) => await context.execute(inner, value),
                        );
                    },
                },
            ],
        });

        expect(await runtime.execute(outer, 4)).toBe(4);
        expect(fixture.calls).toEqual(["begin", "commit"]);
        runtime.close();
    });

    test("rolls back an exception and continues processing queued requests", async () => {
        const fixture = testTransactions();
        const fail = defineOperation<void, void>("fail");
        const read = defineOperation<void, number>("read");
        const runtime = createRuntime({
            transactions: fixture.transactions,
            modules: [
                {
                    id: "test",

                    setup(registrar) {
                        registrar.handleAsync(fail, async () => {
                            fixture.state.value = 7;

                            throw new Error("Expected failure.");
                        });
                        registrar.handleSync(read, () => fixture.state.value);
                    },
                },
            ],
        });

        const failing = runtime.execute(fail, undefined);
        const reading = runtime.execute(read, undefined);
        await expect(failing).rejects.toThrow("Expected failure.");
        expect(await reading).toBe(0);
        expect(fixture.calls).toEqual(["begin", "rollback", "begin", "commit"]);
        runtime.close();
    });

    test("rejects contexts retained after their handler returns", () => {
        const fixture = testTransactions();
        const capture = defineOperation<void, ExecutionContext>("capture");
        const read = defineOperation<void, number>("read");
        const runtime = createRuntime({
            transactions: fixture.transactions,
            modules: [
                {
                    id: "test",

                    setup(registrar) {
                        registrar.handleSync(capture, (_, context) => context);
                        registrar.handleSync(read, () => fixture.state.value);
                    },
                },
            ],
        });

        const context = runtime.executeSync(capture, undefined);
        expectRuntimeError(() => context.executeSync(read, undefined), "ExpiredExecutionContext");
        expect(fixture.calls).toEqual(["begin", "commit"]);
        runtime.close();
    });

    test("drains unfinished nested work before rolling back and rejects its late callbacks", async () => {
        const fixture = testTransactions();
        const childStarted = gate();
        const childContinue = gate();
        const outer = defineOperation<void, void>("outer");
        const child = defineOperation<void, void>("child");
        const write = defineOperation<void, void>("write");
        let lateCallbackError: unknown;
        const runtime = createRuntime({
            transactions: fixture.transactions,
            modules: [
                {
                    id: "test",

                    setup(registrar) {
                        registrar.handleSync(write, () => {
                            fixture.state.value = 99;
                        });
                        registrar.handleAsync(child, async (_, context) => {
                            fixture.state.value = 5;
                            childStarted.release();
                            await childContinue.promise;

                            try {
                                context.executeSync(write, undefined);
                            } catch (error) {
                                lateCallbackError = error;
                            }
                        });
                        registrar.handleAsync(outer, async (_, context) => {
                            void context.execute(child, undefined);
                        });
                    },
                },
            ],
        });

        const running = runtime.execute(outer, undefined);
        await childStarted.promise;
        await Promise.resolve();
        await Promise.resolve();
        expect(runtime.isBusy).toBe(true);
        childContinue.release();
        await expect(running).rejects.toMatchObject({
            code: "UnfinishedExecution",
        });
        expect(lateCallbackError).toMatchObject({
            code: "ExpiredExecutionContext",
        });
        expect(fixture.state.value).toBe(0);
        expect(fixture.calls).toEqual(["begin", "rollback"]);
        runtime.close();
    });

    test("reset clears trace and resets modules; close is idempotent", () => {
        const fixture = testTransactions();
        const operation = defineOperation<void, void>("run");
        const actions: string[] = [];
        const runtime = createRuntime({
            transactions: fixture.transactions,
            modules: [
                {
                    id: "base",

                    setup(registrar) {
                        registrar.handleSync(operation, () => {});
                    },

                    reset() {
                        actions.push("base.reset");
                    },

                    dispose() {
                        actions.push("base.dispose");
                    },
                },
                {
                    id: "dependent",
                    requires: ["base"],

                    setup() {},

                    reset() {
                        actions.push("dependent.reset");
                    },

                    dispose() {
                        actions.push("dependent.dispose");
                    },
                },
            ],
        });
        runtime.executeSync(operation, undefined);
        runtime.reset();
        expect(runtime.trace).toEqual([]);
        runtime.close();
        runtime.close();
        expect(actions).toEqual([
            "dependent.reset",
            "base.reset",
            "dependent.dispose",
            "base.dispose",
        ]);
        expectRuntimeError(() => runtime.executeSync(operation, undefined), "RuntimeClosed");
    });

    test("refuses async functions registered as synchronous void handlers", () => {
        const fixture = testTransactions();
        const operation = defineOperation<void, void>("run");
        let invoked = false;
        expectRuntimeError(
            () =>
                createRuntime({
                    transactions: fixture.transactions,
                    modules: [
                        {
                            id: "invalid",

                            setup(registrar) {
                                // Deliberately supply an invalid async callback to a sync port.
                                // oxlint-disable typescript/no-misused-promises
                                // oxlint-disable typescript/strict-void-return
                                registrar.handleSync(operation, async () => {
                                    invoked = true;
                                });
                                // oxlint-enable typescript/no-misused-promises
                                // oxlint-enable typescript/strict-void-return
                            },
                        },
                    ],
                }),
            "InvalidModule",
        );
        expect(invoked).toBe(false);
    });

    test("records commit failures as failed executions and rolls back", () => {
        const fixture = testTransactions();
        const operation = defineOperation<void, void>("run");
        const runtime = createRuntime({
            transactions: {
                ...fixture.transactions,

                commit() {
                    throw new Error("Commit rejected.");
                },
            },
            modules: [
                {
                    id: "test",

                    setup(registrar) {
                        registrar.handleSync(operation, () => {
                            fixture.state.value = 3;
                        });
                    },
                },
            ],
        });
        expect(() => runtime.executeSync(operation, undefined)).toThrow("Commit rejected.");
        expect(fixture.state.value).toBe(0);
        expect(runtime.trace.at(-1)?.phase).toBe("failure");
        runtime.close();
    });

    test("continues disposing modules when one cleanup hook fails", () => {
        const fixture = testTransactions();
        const actions: string[] = [];
        const runtime = createRuntime({
            transactions: fixture.transactions,
            modules: [
                {
                    id: "base",

                    setup() {},

                    dispose() {
                        actions.push("base.dispose");
                    },
                },
                {
                    id: "dependent",
                    requires: ["base"],

                    setup() {},

                    dispose() {
                        actions.push("dependent.dispose");

                        throw new Error("Cleanup rejected.");
                    },
                },
            ],
        });
        expect(() => runtime.close()).toThrow(AggregateError);
        expect(actions).toEqual(["dependent.dispose", "base.dispose"]);
        runtime.close();
    });

    test("only the registered operation token can invoke its handler", () => {
        const fixture = testTransactions();
        const operation = defineOperation<void, number>("run");
        const other = defineOperation<void, string>("run");
        const runtime = createRuntime({
            transactions: fixture.transactions,
            modules: [
                {
                    id: "test",

                    setup(registrar) {
                        registrar.handleSync(operation, () => 4);
                    },
                },
            ],
        });
        expectRuntimeError(() => runtime.executeSync(other, undefined), "UnknownOperation");
        expect(runtime.executeSync(operation, undefined)).toBe(4);
        runtime.close();
    });

    test("a settled detached child failure still aborts its owning request", async () => {
        const fixture = testTransactions();
        const childSettled = gate();
        const parentContinue = gate();
        const outer = defineOperation<void, void>("outer");
        const child = defineOperation<void, void>("child");
        const failure = new Error("Nested operation rejected.");
        const runtime = createRuntime({
            transactions: fixture.transactions,
            modules: [
                {
                    id: "test",

                    setup(registrar) {
                        registrar.handleAsync(child, async () => {
                            fixture.state.value = 12;

                            throw failure;
                        });
                        registrar.handleAsync(outer, async (_, context) => {
                            void context
                                .execute(child, undefined)
                                .catch(() => childSettled.release());
                            await parentContinue.promise;
                        });
                    },
                },
            ],
        });

        const running = runtime.execute(outer, undefined);
        await childSettled.promise;
        parentContinue.release();
        await expect(running).rejects.toBe(failure);
        expect(fixture.state.value).toBe(0);
        expect(fixture.calls).toEqual(["begin", "rollback"]);
        runtime.close();
    });

    test("caught synchronous handler exceptions also abort the request", () => {
        const fixture = testTransactions();
        const outer = defineOperation<void, void>("outer");
        const child = defineOperation<void, void>("child");
        const failure = new Error("Nested operation rejected.");
        const runtime = createRuntime({
            transactions: fixture.transactions,
            modules: [
                {
                    id: "test",

                    setup(registrar) {
                        registrar.handleSync(child, () => {
                            fixture.state.value = 12;

                            throw failure;
                        });
                        registrar.handleSync(outer, (_, context) => {
                            try {
                                context.executeSync(child, undefined);
                            } catch {
                                // Catching the error must not prevent rollback.
                            }
                        });
                    },
                },
            ],
        });

        expect(() => runtime.executeSync(outer, undefined)).toThrow(failure);
        expect(fixture.state.value).toBe(0);
        expect(fixture.calls).toEqual(["begin", "rollback"]);
        runtime.close();
    });

    test("rejects native async transaction callbacks before setup or invocation", () => {
        for (const step of ["begin", "commit", "rollback"] as const) {
            const fixture = testTransactions();
            let invoked = false;
            let setup = false;
            const transactions: TransactionBoundary = {
                ...fixture.transactions,

                [step]: async () => {
                    invoked = true;
                },
            };
            expectRuntimeError(
                () =>
                    createRuntime({
                        transactions,
                        modules: [
                            {
                                id: "test",

                                setup() {
                                    setup = true;
                                },
                            },
                        ],
                    }),
                "InvalidTransactionBoundary",
            );
            expect(invoked).toBe(false);
            expect(setup).toBe(false);
        }
    });

    test("rejects a Promise returned by a non-async transaction callback", () => {
        const fixture = testTransactions();
        const operation = defineOperation<void, void>("run");
        let invoked = false;
        const runtime = createRuntime({
            transactions: {
                ...fixture.transactions,

                // The runtime must reject an untyped transaction boundary returning a Promise.
                // oxlint-disable typescript/no-misused-promises
                // oxlint-disable typescript/strict-void-return
                begin() {
                    return Promise.resolve();
                },
                // oxlint-enable typescript/no-misused-promises
                // oxlint-enable typescript/strict-void-return
            },
            modules: [
                {
                    id: "test",

                    setup(registrar) {
                        registrar.handleSync(operation, () => {
                            invoked = true;
                        });
                    },
                },
            ],
        });
        expectRuntimeError(
            () => runtime.executeSync(operation, undefined),
            "InvalidTransactionBoundary",
        );
        expect(invoked).toBe(false);
        expect(runtime.isBusy).toBe(false);
        runtime.close();
    });
});
