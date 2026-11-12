import { expect, test } from "bun:test";

import { createHarness, ExecutionOutcome, ObserverError } from "../src/index.js";
import type { ExecutionReport } from "../src/index.js";
import { controlProject } from "./helpers/controls.js";

const asynchronousObserver: unknown = async () => {
    /* Invalid observer contract. */
};

test("observers receive immutable settled reports and can inspect committed raw state", async () => {
    await using project = await controlProject();
    using h = await createHarness({ cwd: project.cwd });
    const reports: ExecutionReport[] = [];
    using _observation = h.observe((report) => {
        reports.push(report);
        expect(report.outcome).toBe(ExecutionOutcome.Committed);
        expect(h.state.get("ControlAudit")).toHaveLength(1);
        expect(Object.isFrozen(report.calls)).toBe(true);
    });
    await h.add("ControlAudit", { name: "Recorded" });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toBe(h.executions.at(-1));
    expect(reports[0]?.failures).toEqual([]);
});

test("observer failures preserve committed data, notify other subscribers and surface separately", async () => {
    await using project = await controlProject();
    using h = await createHarness({ cwd: project.cwd });
    const failure = new Error("Broken observer");
    const reports: ExecutionReport[] = [];
    using broken = h.observe(() => {
        throw failure;
    });
    using _healthy = h.observe((report) => {
        reports.push(report);
    });
    await expect(h.add("ControlAudit", { name: "Committed" })).rejects.toBeInstanceOf(
        ObserverError,
    );
    expect(h.state.getOne("ControlAudit", { name: "Committed" })).toBeDefined();
    expect(reports).toHaveLength(1);
    expect(reports[0]?.outcome).toBe(ExecutionOutcome.Committed);
    expect(reports[0]?.error).toBeUndefined();
    broken[Symbol.dispose]();
    await h.add("ControlAudit", { name: "Next" });
    expect(reports).toHaveLength(2);
});

test("business and observer failures are both retained after rollback", async () => {
    await using project = await controlProject();
    using h = await createHarness({
        cwd: project.cwd,
        mocks: [{ method: "Reject", response: { error: "Business rejection" } }],
    });
    using _observation = h.observe(() => {
        throw new Error("Observer rejection");
    });
    let failure: unknown;

    try {
        await h.callMethod("Reject");
    } catch (error) {
        failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);

    if (!(failure instanceof AggregateError)) {
        throw new TypeError("Expected both failures.");
    }

    expect(failure.errors).toHaveLength(2);
    expect(failure.errors[1]).toBeInstanceOf(ObserverError);
    expect(h.executions.at(-1)).toMatchObject({
        outcome: ExecutionOutcome.RolledBack,
        error: { message: "Business rejection" },
    });
});

test("subscriptions survive reset and dispose independently of report retention", async () => {
    await using project = await controlProject();
    using h = await createHarness({ cwd: project.cwd });
    const reports: ExecutionReport[] = [];
    const observation = h.observe((report) => {
        reports.push(report);
    });
    await h.get("ControlledDocument");
    h.reset();
    expect(h.executions).toHaveLength(0);
    await h.get("ControlledDocument");
    expect(reports).toHaveLength(2);
    observation[Symbol.dispose]();
    observation[Symbol.dispose]();
    await h.get("ControlledDocument");
    expect(reports).toHaveLength(2);
});

test("asynchronous observers are rejected and cannot silently lose failures", async () => {
    await using project = await controlProject();
    using h = await createHarness({ cwd: project.cwd });
    expect(() => {
        Reflect.apply(h.observe.bind(h), h, [asynchronousObserver]);
    }).toThrow("synchronous");
    // Deliberately exercise a JavaScript callback that violates the return contract.
    // oxlint-disable-next-line typescript/strict-void-return, typescript/no-misused-promises
    using _invalid = h.observe(() => Promise.reject(new Error("Invalid async callback")));
    await expect(h.get("ControlledDocument")).rejects.toBeInstanceOf(ObserverError);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.Committed);
});
