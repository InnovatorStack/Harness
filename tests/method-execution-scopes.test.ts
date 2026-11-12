import { afterEach, expect, test } from "bun:test";

import { defineOperation } from "../src/core/operation.js";
import { Runtime } from "../src/core/runtime.js";
import type { ExecutionContext, HarnessModule } from "../src/core/types.js";
import { MethodExecutionScopes } from "../src/platform/security/method-execution.js";

const runtimes: Runtime[] = [];

afterEach(() => {
    for (const runtime of runtimes.splice(0)) {
        runtime.close();
    }
});

function world(module: HarnessModule): Runtime {
    const runtime = new Runtime({
        modules: [module],
        transactions: {
            begin() {},

            commit() {},

            rollback() {},
        },
    });
    runtimes.push(runtime);

    return runtime;
}

test("NoCheck follows extension-operation ancestry without affecting a concurrent sibling", async () => {
    const scopes = new MethodExecutionScopes();
    const root = defineOperation<void, void>("scope.root");
    const bound = defineOperation<void, void>("scope.bound");
    const extension = defineOperation<void, void>("scope.extension");
    const probe = defineOperation<void, boolean>("scope.probe");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const runtime = world({
        id: "scope-test",

        setup(registrar) {
            registrar.handleSync(probe, (_, context) => {
                using scope = scopes.enter(context, false);

                return scope.checkExecutionIdentity;
            });
            registrar.handleAsync(extension, async (_, context) => {
                expect(context.executeSync(probe, undefined)).toBe(false);
            });
            registrar.handleAsync(bound, async (_, context) => {
                using scope = scopes.enter(context, true);
                expect(scope.checkExecutionIdentity).toBe(false);
                entered.resolve();
                await release.promise;
                await context.execute(extension, undefined);
            });
            registrar.handleAsync(root, async (_, context) => {
                const active = context.execute(bound, undefined);
                await entered.promise;
                expect(context.executeSync(probe, undefined)).toBe(true);
                release.resolve();
                await active;
                expect(context.executeSync(probe, undefined)).toBe(true);
            });
        },
    });

    await runtime.execute(root, undefined);
});

test("matching execution IDs in another runtime cannot inherit an active Method scope", async () => {
    const scopes = new MethodExecutionScopes();
    const probe = defineOperation<void, boolean>("scope.other");
    const root = defineOperation<void, void>("scope.root");
    const other = world({
        id: "other-scope",

        setup(registrar) {
            registrar.handleSync(probe, (_, context) => {
                using scope = scopes.enter(context, false);

                return scope.checkExecutionIdentity;
            });
        },
    });
    const runtime = world({
        id: "current-scope",

        setup(registrar) {
            registrar.handleAsync(root, async (_, context) => {
                using scope = scopes.enter(context, true);
                expect(scope.checkExecutionIdentity).toBe(false);
                expect(other.executeSync(probe, undefined)).toBe(true);
            });
        },
    });

    await runtime.execute(root, undefined);
});

test("an abandoned Method cannot carry NoCheck past rollback or a scope reset", async () => {
    const scopes = new MethodExecutionScopes();
    const root = defineOperation<void, void>("scope.failed");
    const child = defineOperation<void, void>("scope.abandoned");
    const probe = defineOperation<void, boolean>("scope.next");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let abandoned: ExecutionContext | undefined;
    const runtime = world({
        id: "failed-scope",

        setup(registrar) {
            registrar.handleAsync(child, async (_, context) => {
                using scope = scopes.enter(context, true);
                abandoned = context;
                expect(scope.checkExecutionIdentity).toBe(false);
                entered.resolve();
                await release.promise;
            });
            registrar.handleAsync(root, async (_, context) => {
                void context.execute(child, undefined);
                await entered.promise;

                throw new Error("Reject owning request");
            });
            registrar.handleSync(probe, (_, context) => {
                using scope = scopes.enter(context, false);

                return scope.checkExecutionIdentity;
            });
        },
    });

    await expect(runtime.execute(root, undefined)).rejects.toThrow("Reject owning request");
    expect(runtime.executeSync(probe, undefined)).toBe(true);

    const expired = abandoned;

    if (!expired) {
        throw new Error("The abandoned handler must expose its expired context.");
    }

    expect(() => scopes.enter(expired, false)).toThrow();
    scopes.reset();
    release.resolve();
    await Promise.resolve();
    expect(runtime.executeSync(probe, undefined)).toBe(true);
});
