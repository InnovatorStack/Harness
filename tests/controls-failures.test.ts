import { expect, test } from "bun:test";

import {
    createHarness,
    ExecutionOutcome,
    FailurePoint,
    InjectedFailureError,
    ItemAction,
} from "../src/index.js";
import { controlProject } from "./helpers/controls.js";

test("after-call failure rolls back generations and copied relationships before notifying observers", async () => {
    await using project = await controlProject();
    using h = await createHarness({ cwd: project.cwd });
    const document = h.state.getOne("ControlledDocument", { item_number: "DOC-001" });
    const documents = h.state.get("ControlledDocument");
    const links = h.state.get("ControlledLink");
    let observed = false;
    using _observation = h.observe((report) => {
        observed = true;
        expect(report.outcome).toBe(ExecutionOutcome.RolledBack);
        expect(h.state.get("ControlledDocument")).toEqual(documents);
        expect(h.state.get("ControlledLink")).toEqual(links);
    });
    using failure = h.injectFailure({
        type: "ControlledDocument",
        action: ItemAction.Edit,
        when: { id: document.id },
        at: FailurePoint.AfterCall,
        error: new Error("Failure after saving"),
    });

    await expect(h.update(document, { description: "Changed" })).rejects.toThrow(
        "Failure after saving",
    );

    expect(failure.triggered).toBe(true);
    expect(observed).toBe(true);
    expect(h.state.get("ControlledDocument")).toEqual(documents);
    expect(h.state.get("ControlledLink")).toEqual(links);
    const run = h.executions.at(-1);
    expect(run?.changes.length).toBeGreaterThan(1);
    expect(run?.changes.every((change) => change.outcome === ExecutionOutcome.RolledBack)).toBe(
        true,
    );
    expect(run?.failures).toMatchObject([
        {
            name: "ControlledDocument.edit",
            at: FailurePoint.AfterCall,
            occurrence: 1,
        },
    ]);
    expect(Object.isFrozen(run?.failures[0]?.error)).toBe(true);
});

test("before-call failures retain their original cause and fire once", async () => {
    await using project = await controlProject();
    using h = await createHarness({ cwd: project.cwd });
    const cause = new Error("Unavailable storage");
    using failure = h.injectFailure({
        type: "ControlAudit",
        action: ItemAction.Add,
        error: cause,
    });

    const error: unknown = await h
        .add("ControlAudit", { name: "Rejected" })
        .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(InjectedFailureError);
    expect(error).toHaveProperty("cause", cause);
    expect(failure.triggered).toBe(true);
    expect(h.state.get("ControlAudit")).toEqual([]);
    expect(h.executions.at(-1)?.changes).toEqual([]);
    await h.add("ControlAudit", { name: "Allowed" });
    expect(h.state.get("ControlAudit")).toHaveLength(1);
    expect(h.executions.at(-1)?.failures).toEqual([]);
});

test("occurrences count matching entries and leave other calls alone", async () => {
    await using project = await controlProject();
    using h = await createHarness({ cwd: project.cwd });
    using failure = h.injectFailure({
        type: "ControlAudit",
        action: ItemAction.Add,
        when: { name: "Selected" },
        occurrence: 2,
        at: FailurePoint.AfterCall,
        error: new Error("Second selected invocation"),
    });

    await h.add("ControlAudit", { name: "Other" });
    await h.add("ControlAudit", { name: "Selected" });
    expect(failure.triggered).toBe(false);
    await expect(h.add("ControlAudit", { name: "Selected" })).rejects.toThrow(
        "Second selected invocation",
    );
    await h.add("ControlAudit", { name: "Selected" });

    expect(failure.triggered).toBe(true);
    expect(h.state.get("ControlAudit", { name: "Selected" })).toHaveLength(2);
});

test("disposal and reset remove unused failures without asserting that they fired", async () => {
    await using project = await controlProject();
    using h = await createHarness({ cwd: project.cwd });
    const injection = {
        type: "ControlAudit",
        action: ItemAction.Add,
        error: new Error("Unused failure"),
    };
    const disposed = h.injectFailure(injection);
    disposed[Symbol.dispose]();
    disposed[Symbol.dispose]();
    await h.add("ControlAudit", { name: "Allowed after disposal" });
    const reset = h.injectFailure(injection);
    h.reset();
    await h.add("ControlAudit", { name: "Allowed after reset" });

    expect(disposed.triggered).toBe(false);
    expect(reset.triggered).toBe(false);
    expect(h.executions.at(-1)?.failures).toEqual([]);
});

test("ambiguous failures reject before execution instead of choosing a rule silently", async () => {
    await using project = await controlProject();
    using h = await createHarness({ cwd: project.cwd });
    const injection = {
        type: "ControlAudit",
        action: ItemAction.Add,
        error: new Error("Ambiguous"),
    };
    using first = h.injectFailure(injection);
    using second = h.injectFailure(injection);

    await expect(h.add("ControlAudit", { name: "Rejected" })).rejects.toMatchObject({
        code: "AmbiguousInjection",
    });

    expect(first.triggered).toBe(false);
    expect(second.triggered).toBe(false);
    expect(h.state.get("ControlAudit")).toEqual([]);
    expect(h.executions.at(-1)?.failures).toEqual([]);
});

test("after-call failures only fire when the selected invocation succeeds", async () => {
    await using project = await controlProject();
    using h = await createHarness({
        cwd: project.cwd,
        mocks: [
            {
                method: "RejectedMethod",
                response: { error: "Business rejection" },
            },
        ],
    });
    using failure = h.injectFailure({
        method: "RejectedMethod",
        at: FailurePoint.AfterCall,
        error: new Error("Must not hide the real error"),
    });

    const result = await h.callMethod("RejectedMethod");

    expect(result.isError()).toBe(true);
    expect(result.getErrorString()).toBe("Business rejection");

    expect(failure.triggered).toBe(false);
    expect(h.executions.at(-1)?.failures).toEqual([]);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
});

test("transaction rollback consumes issued IDs while reset restores their starting position", async () => {
    await using project = await controlProject();
    using h = await createHarness({ cwd: project.cwd });
    using failure = h.injectFailure({
        type: "ControlAudit",
        action: ItemAction.Add,
        at: FailurePoint.AfterCall,
        error: new Error("Rollback"),
    });

    await expect(h.add("ControlAudit", { name: "Rejected" })).rejects.toThrow("Rollback");
    const rejectedId = h.executions.at(-1)?.changes.at(-1)?.after?.id;
    expect(rejectedId).toBeDefined();

    if (!rejectedId) {
        throw new Error("The attempted insert must report its issued ID.");
    }

    const next = await h.add("ControlAudit", { name: "Next" });
    expect(next.id).not.toBe(rejectedId);
    h.reset();
    const repeated = await h.add("ControlAudit", { name: "Repeated" });

    expect(failure.triggered).toBe(true);
    expect(repeated.id).toBe(rejectedId);
});
