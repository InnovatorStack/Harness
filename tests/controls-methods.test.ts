import { expect, test } from "bun:test";

import { createHarness, ExecutionOutcome, FailurePoint, ItemAction } from "../src/index.js";
import { controlMethod, controlProject } from "./helpers/controls.js";

const caughtFailure = `
var inn = this.getInnovator();
var first = inn.newItem("ControlAudit", "add");
first.setProperty("name", "Earlier write");
first.apply();
try
{
    var second = inn.newItem("ControlAudit", "add");
    second.setProperty("name", "Rejected write");
    second.apply();
}
catch (Exception)
{
    // An injected platform failure still poisons the owning transaction.
}
return this;`;

test("a real C# caller cannot swallow an injected nested failure and commit earlier writes", async () => {
    await using project = await controlProject(controlMethod("CatchFailure", caughtFailure));
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    using failure = h.injectFailure({
        type: "ControlAudit",
        action: ItemAction.Add,
        when: { name: "Rejected write" },
        at: FailurePoint.AfterCall,
        error: new Error("Nested storage failure"),
    });

    await expect(h.callMethod("CatchFailure")).rejects.toThrow("Nested storage failure");

    expect(failure.triggered).toBe(true);
    expect(h.state.get("ControlAudit")).toEqual([]);
    const report = h.executions.at(-1);
    expect(report?.outcome).toBe(ExecutionOutcome.RolledBack);
    expect(report?.changes).toHaveLength(2);
    expect(report?.calls[0]).toMatchObject({ name: "CatchFailure", executed: true });
}, 60_000);

test("failure targets include imported event Methods before their mock or executor runs", async () => {
    const method = controlMethod("OnBeforeEdit", "return this;");
    const binding = `<Item type="Server Event" action="add">
        <source_id>CONTROL_DOCUMENT</source_id><related_id>CONTROL_OnBeforeEdit</related_id>
        <server_event>onBeforeUpdate</server_event></Item>`;
    await using project = await controlProject(method + binding);
    using h = await createHarness({
        cwd: project.cwd,
        mocks: [
            {
                method: "OnBeforeEdit",
                response: { aml: '<Item type="ControlledDocument" />' },
            },
        ],
    });
    const original = h.state.getOne("ControlledDocument", { item_number: "DOC-001" });
    using failure = h.injectFailure({
        method: "CONTROL_OnBeforeEdit",
        when: { description: "Changed" },
        error: new Error("Rejected event"),
    });

    await expect(h.update(original, { description: "Changed" })).rejects.toThrow("Rejected event");

    expect(failure.triggered).toBe(true);
    const report = h.executions.at(-1);
    expect(report?.mocks).toEqual([]);
    expect(report?.failures[0]?.source?.file).toEndWith("source.xml");
    expect(report?.calls[0]?.children.map((call) => call.name)).toEqual(["OnBeforeEdit"]);
    expect(report?.changes).toHaveLength(1);
    expect(report?.changes[0]).toMatchObject({
        name: "lock",
        before: { id: original.id },
        after: { id: original.id },
    });
    expect(report?.calls[0]?.children.find((call) => call.name === "OnBeforeEdit")).toMatchObject({
        name: "OnBeforeEdit",
        executed: false,
        definition: { type: "Method", id: "CONTROL_OnBeforeEdit" },
        sourceHash: new Bun.CryptoHasher("sha256").update("return this;").digest("hex"),
    });
    expect(h.state.getOne("ControlledDocument", { id: original.id })).toEqual(original);
});

test("named SQL failures intercept the same parameters as ordinary SQL mocks", async () => {
    await using project = await controlProject();
    using h = await createHarness({
        cwd: project.cwd,
        mocks: [
            {
                sql: "LookupActivities",
                response: { text: "Normally mocked" },
            },
        ],
    });
    using failure = h.injectFailure({
        sql: "LookupActivities",
        when: { ARG1: "Selected" },
        error: new Error("SQL unavailable"),
    });

    await expect(
        h.applyAML(`<Item type="SQL" action="SQL Process">
        <name>LookupActivities</name><ARG1>Selected</ARG1></Item>`),
    ).rejects.toThrow("SQL unavailable");

    expect(failure.triggered).toBe(true);
    expect(h.executions.at(-1)?.mocks).toEqual([]);
    expect(h.executions.at(-1)?.failures[0]?.name).toBe("LookupActivities");
});

test("inline SQL faults match nested caller data and run after a successful mock response", async () => {
    const code = 'return this.getInnovator().applySQL("select known_data");';
    await using project = await controlProject(controlMethod("ReadSql", code));
    using h = await createHarness({
        cwd: project.cwd,
        csharp: {},
        mocks: [
            {
                sql: true,
                response: { text: "Known SQL result" },
            },
        ],
    });
    using failure = h.injectFailure({
        sql: true,
        when: { method: "ReadSql", project: { name: "Selected" } },
        at: FailurePoint.AfterCall,
        error: new Error("After SQL response"),
    });

    await expect(h.callMethod("ReadSql", { project: { name: "Selected" } })).rejects.toThrow(
        "After SQL response",
    );

    expect(failure.triggered).toBe(true);
    expect(h.executions.at(-1)?.mocks).toHaveLength(1);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
}, 60_000);
