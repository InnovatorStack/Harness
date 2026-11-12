import { expect, test } from "bun:test";

import { createHarness, ItemAction } from "../src/index.js";
import { controlMethod, controlProject } from "./helpers/controls.js";

function deferred() {
    let finish: (() => void) | undefined;
    const promise = new Promise<void>((resolve) => {
        finish = resolve;
    });

    return {
        promise,

        release() {
            if (!finish) {
                throw new Error("The deferred Promise must be initialized.");
            }

            finish();
        },
    };
}

test("active work prevents raw reads, control mutation, reset and new subscriptions", async () => {
    await using project = await controlProject(controlMethod("Hold", "return this;"));
    const entered = deferred();
    const resume = deferred();
    using h = await createHarness({
        cwd: project.cwd,
        executors: [
            () => ({
                language: "C#",

                async execute(_method, context) {
                    entered.release();
                    await resume.promise;

                    return context;
                },
            }),
        ],
    });
    const request = h.callMethod("Hold");
    await entered.promise;

    try {
        expect(() => h.state.get("ControlledDocument")).toThrow("active operations");
        expect(() => h.clock.set("2027-01-01T00:00:00Z")).toThrow("active operations");
        expect(() => h.clock.advance(1)).toThrow("active operations");
        expect(() => h.reset()).toThrow("active operations");
        expect(() =>
            h.observe(() => {
                /* Registration requires an idle world. */
            }),
        ).toThrow("active operations");
        expect(() =>
            h.injectFailure({
                method: "Hold",
                error: new Error("Unavailable"),
            }),
        ).toThrow("active operations");
    } finally {
        resume.release();
        await request;
    }

    expect(h.state.get("ControlledDocument")).toHaveLength(2);
    expect(h.clock.now().toISOString()).toBe("2026-01-01T09:00:00.000Z");
});

test("observers may read settled state but cannot mutate controls or reenter business calls", async () => {
    await using project = await controlProject();
    using h = await createHarness({ cwd: project.cwd });
    const reentries: Promise<unknown>[] = [];
    using _observation = h.observe(() => {
        expect(h.state.get("ControlAudit")).toHaveLength(1);
        expect(() => h.clock.advance(1)).toThrow("active operations");
        expect(() => h.reset()).toThrow("active operations");
        reentries.push(h.add("ControlAudit", { name: "Rejected reentry" }));
        void reentries.at(-1)?.catch(() => {
            // The test inspects this rejection after observer notification finishes.
        });
    });

    await h.add("ControlAudit", { name: "Committed" });

    expect(reentries).toHaveLength(1);
    await expect(reentries[0]).rejects.toMatchObject({ code: "WorldBusy" });
    expect(h.state.get("ControlAudit")).toHaveLength(1);
    expect(h.executions).toHaveLength(1);
});

test("observer errors do not block queued requests or reset another world's controls", async () => {
    await using project = await controlProject();
    using first = await createHarness({ cwd: project.cwd });
    using second = await createHarness({ cwd: project.cwd });
    let notifications = 0;
    using observation = first.observe(() => {
        notifications += 1;

        if (notifications === 1) {
            throw new Error("First observation failed");
        }
    });
    const results = await Promise.allSettled([
        first.add("ControlAudit", { name: "First" }),
        first.add("ControlAudit", { name: "Second" }),
    ]);

    expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled"]);
    expect(first.state.get("ControlAudit")).toHaveLength(2);
    expect(first.executions).toHaveLength(2);
    observation[Symbol.dispose]();
    using failure = first.injectFailure({
        type: "ControlAudit",
        action: ItemAction.Add,
        error: new Error("World-local failure"),
    });
    second.reset();

    await expect(first.add("ControlAudit", { name: "Rejected" })).rejects.toThrow("World-local");
    expect(failure.triggered).toBe(true);
    expect(second.state.get("ControlAudit")).toEqual([]);
});
