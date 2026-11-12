import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRuntime, defineOperation } from "../src/core/index.js";
import {
    createHarness,
    checkCompatibility,
    CapabilityId,
    CompatibilityIssueCode,
    ExecutionKind,
    ExecutionMode,
    ExecutionOutcome,
    ExecutionStatus,
} from "../src/index.js";
import type { ExecutionCall, Harness, HarnessOptions } from "../src/index.js";
import { ExecutionRecorder } from "../src/instrumentation/recorder.js";
import { Snapshots } from "../src/instrumentation/snapshots.js";
import { Item } from "../src/items/item.js";

const directories: string[] = [];
const worlds: Harness[] = [];
const schema = `<Item type="ItemType" action="add" id="TRACKED_TYPE">
  <name>TrackedRecord</name><is_versionable>0</is_versionable>
  <Relationships>
    <Item type="Property" action="add"><name>name</name><data_type>string</data_type></Item>
    <Item type="Property" action="add"><name>note</name><data_type>string</data_type></Item>
  </Relationships>
</Item>`;

function method(name: string, code: string, language = "C#"): string {
    return `<Item type="Method" action="add" id="METHOD_${name}">
    <name>${name}</name><method_type>${language}</method_type>
    <method_code><![CDATA[${code}]]></method_code>
  </Item>`;
}

async function project(source = "", files: Readonly<Record<string, string>> = {}): Promise<string> {
    const temporary = await mkdtemp(join(tmpdir(), "harness-instrumentation-"));
    directories.push(temporary);
    const directory = await realpath(temporary);
    await mkdir(join(directory, ".harness/packages"), { recursive: true });
    await Bun.write(
        join(directory, ".harness/packages/source.xml"),
        `<AML>${schema}${source}</AML>`,
    );
    await Bun.write(
        join(directory, ".harness/fixtures.ts"),
        'export default {TrackedRecord: [{name: "Original"}]};',
    );

    for (const [path, contents] of Object.entries(files)) {
        await Bun.write(join(directory, path), contents);
    }

    return directory;
}

async function open(
    directory: string,
    options: HarnessOptions = { csharp: false },
): Promise<Harness> {
    const harness = await createHarness({ cwd: directory, ...options });
    worlds.push(harness);

    return harness;
}

function calls(roots: readonly ExecutionCall[]): readonly ExecutionCall[] {
    const result: ExecutionCall[] = [];
    const pending = [...roots];

    while (pending.length > 0) {
        const call = pending.shift();

        if (call) {
            result.push(call);
            pending.unshift(...call.children);
        }
    }

    return result;
}

afterEach(async () => {
    for (const world of worlds.splice(0)) {
        world.close();
    }

    await Promise.all(
        directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
});

test("ordinary calls record immutable inputs, results and changes after automatic setup", async () => {
    const directory = await project();
    const h = await open(directory);
    expect(h.executions).toEqual([]);
    const record = await h.getOne("TrackedRecord", { name: "Original" });
    h.clearExecutions();

    const updated = await h.update(record, { name: "Changed" });
    const run = h.executions.at(-1);

    expect(run).toMatchObject({ outcome: ExecutionOutcome.Committed, truncated: false });
    expect(run?.calls[0]).toMatchObject({
        name: "TrackedRecord.edit",
        kind: ExecutionKind.Action,
        status: ExecutionStatus.Succeeded,
        input: { items: [{ properties: { name: "Changed" } }] },
        result: { items: [{ attributes: { id: updated.id }, properties: { name: "Changed" } }] },
    });
    expect(run?.changes).toMatchObject([
        {
            name: "update",
            before: { id: record.id, properties: { name: "Original" } },
            after: { id: updated.id, properties: { name: "Changed" } },
            outcome: ExecutionOutcome.Committed,
        },
    ]);
    expect(run?.durationMs).toBeGreaterThanOrEqual(0);
    expect(Object.isFrozen(run?.calls[0]?.input)).toBe(true);
    expect(Object.isFrozen(run?.changes[0]?.after?.properties)).toBe(true);
    await h.update(updated, { name: "Later" });
    expect(run?.changes[0]?.after?.properties.name).toBe("Changed");
});

test("a real C# call and imported event hook form a source-linked parent/child tree", async () => {
    const outer = 'Item query = this.newItem("TrackedRecord", "get"); return query.apply();';
    const hook = 'this.setProperty("name", "Original"); return this;';
    const directory = await project(`${method("Load", outer)}${method("Filter", hook)}
    <Item type="Server Event" action="add" id="FILTER_EVENT">
      <source_id>TRACKED_TYPE</source_id><related_id>METHOD_Filter</related_id>
      <server_event>onBeforeGet</server_event><sort_order>10</sort_order>
    </Item>`);
    const h = await open(directory, {});

    await h.callMethod("Load");
    const run = h.executions.at(-1);
    const tree = calls(run?.calls ?? []);

    expect(tree.map((call) => call.name)).toEqual(["Load", "TrackedRecord.get", "Filter"]);
    expect(tree[1]?.parentExecutionId).toBe(tree[0]?.executionId);
    expect(tree[2]?.parentExecutionId).toBe(tree[1]?.executionId);
    expect(tree[2]?.via).toMatchObject({
        name: "onBeforeGet",
        source: { file: join(directory, ".harness/packages/source.xml") },
    });
    expect(tree[0]?.sourceHash).toBe(new Bun.CryptoHasher("sha256").update(outer).digest("hex"));
    expect(tree[2]?.sourceHash).toBe(new Bun.CryptoHasher("sha256").update(hook).digest("hex"));
    expect(
        tree.filter((call) => call.kind === ExecutionKind.Method).every((call) => call.executed),
    ).toBe(true);
    expect(run?.outcome).toBe(ExecutionOutcome.Committed);
    expect(h.trace.some((event) => event.parentExecutionId !== undefined)).toBe(true);
}, 60_000);

test("business error results retain attempted writes and identify their rollback", async () => {
    const code = `
    Item record = this.newItem("TrackedRecord", "get");
    record.setProperty("name", "Original");
    record = record.apply();
    record.setAction("edit");
    record.setProperty("name", "Attempted");
    record.apply();
    return this.getInnovator().newError("Submission rejected");
  `;
    const directory = await project(method("Reject", code));
    const h = await open(directory, {});

    const response = await h.callMethod("Reject");
    const run = h.executions.at(-1);

    expect(response.isError()).toBe(true);
    expect(run?.outcome).toBe(ExecutionOutcome.RolledBack);
    expect(run?.calls[0]).toMatchObject({
        executed: true,
        status: ExecutionStatus.Failed,
        result: { error: { message: "Submission rejected" } },
    });
    expect(run?.changes[0]).toMatchObject({
        after: { properties: { name: "Attempted" } },
        outcome: ExecutionOutcome.RolledBack,
    });
    expect(calls(run?.calls ?? []).find((call) => call.name === "TrackedRecord.edit")?.status).toBe(
        ExecutionStatus.Succeeded,
    );
    expect(run?.error).toMatchObject({
        name: "ApplicationError",
        code: "ApplicationError",
        message: "Submission rejected",
    });
    expect((await h.getOne("TrackedRecord", { name: "Original" })).properties.name).toBe(
        "Original",
    );
}, 60_000);

test("SQL mocks retain provenance without becoming source execution evidence", async () => {
    const code =
        'Item query = this.newItem("SQL", "SQL Process"); query.setProperty("name", "TrackedQuery"); return query.apply();';
    const directory = await project(
        `${method("Load", code)}
    <Item type="SQL" action="add" id="TRACKED_SQL"><name>TrackedQuery</name><sqlserver_body>SELECT unavailable_source</sqlserver_body></Item>`,
        {
            ".harness/mocks.json": JSON.stringify([
                { sql: "TrackedQuery", response: "./responses/query.xml" },
            ]),
            ".harness/responses/query.xml":
                '<AML><Item type="TrackedRecord" id="CAPTURED"><name>Captured</name></Item></AML>',
        },
    );
    const h = await open(directory, {});

    const result = await h.callMethod("Load");
    const run = h.executions.at(-1);
    const sqlCall = calls(run?.calls ?? []).find((call) => call.kind === ExecutionKind.Sql);

    expect(result.getProperty("name")).toBe("Captured");
    expect(sqlCall).toMatchObject({
        mode: ExecutionMode.Mocked,
        executed: false,
        definition: { type: "SQL", id: "TRACKED_SQL" },
    });
    expect(run?.mocks[0]).toMatchObject({
        name: "SQL Process: TrackedQuery",
        responseFile: join(directory, ".harness/responses/query.xml"),
    });
    const compatibility = await checkCompatibility({ cwd: directory, executions: h.executions });
    expect(compatibility.methods[0]?.executed).toBe(true);
    expect(compatibility.sql[0]?.executed).toBe(false);
    expect(compatibility.sql[0]?.observations[0]).toMatchObject({
        mode: ExecutionMode.Mocked,
        outcome: ExecutionOutcome.Committed,
    });
    expect(compatibility.methods[0]?.referenceVerified).toBe(false);
}, 60_000);

test("mocked Methods bypass compilation and remain distinct in compatibility observations", async () => {
    const directory = await project(method("External", "does not compile"), {
        ".harness/mocks.json": JSON.stringify([
            { method: "External", response: { text: "Captured" } },
        ]),
    });
    const h = await open(directory);
    await h.callMethod("External");

    expect(h.executions[0]?.calls[0]).toMatchObject({
        kind: ExecutionKind.Method,
        mode: ExecutionMode.Mocked,
        executed: false,
    });
    const compatibility = await checkCompatibility({
        cwd: directory,
        csharp: false,
        executions: h.executions,
    });
    expect(compatibility.methods[0]?.executed).toBe(false);
    expect(compatibility.methods[0]?.observations[0]).toMatchObject({
        mode: ExecutionMode.Mocked,
        executed: false,
    });
});

test("unsupported nested SQL retains the original capability, call chain and rolled-back state", async () => {
    const code = `
    Item record = this.newItem("TrackedRecord", "get"); record.setProperty("name", "Original"); record = record.apply();
    record.setAction("edit"); record.setProperty("name", "Attempted"); record.apply();
    return this.getInnovator().applySQL("SELECT unavailable_source");
  `;
    const directory = await project(method("Submit", code));
    const h = await open(directory, {});

    await expect(h.callMethod("Submit")).rejects.toMatchObject({ code: "UnsupportedSQL" });
    const run = h.executions.at(-1);

    expect(run?.error).toMatchObject({
        code: "UnsupportedSQL",
        capability: CapabilityId.TSql,
        source: { file: join(directory, ".harness/packages/source.xml") },
    });
    expect(run?.error?.callChain.map((entry) => entry.name)).toEqual(["Submit", "SQL: Submit"]);
    expect(run?.changes[0]?.outcome).toBe(ExecutionOutcome.RolledBack);
    expect(run?.calls[0]?.executed).toBe(true);
    const compatibility = await checkCompatibility({ cwd: directory, executions: h.executions });
    expect(compatibility.methods[0]?.executed).toBe(true);
    expect(compatibility.methods[0]?.observations[0]).toMatchObject({
        status: ExecutionStatus.Failed,
        outcome: ExecutionOutcome.RolledBack,
    });
    expect((await h.getOne("TrackedRecord", { name: "Original" })).properties.name).toBe(
        "Original",
    );
}, 60_000);

test("compilation failures are attempted calls without source execution", async () => {
    const directory = await project(method("Broken", "return nonexistentSymbol;"));
    const h = await open(directory, {});

    await expect(h.callMethod("Broken")).rejects.toMatchObject({ code: "MethodCompilationFailed" });
    const run = h.executions.at(-1);

    expect(run?.calls[0]).toMatchObject({
        name: "Broken",
        executed: false,
        status: ExecutionStatus.Failed,
    });
    expect(run?.error?.capability).toBe(CapabilityId.CSharp);
    const compatibility = await checkCompatibility({ cwd: directory, executions: h.executions });
    expect(compatibility.methods[0]?.executed).toBe(false);
    expect(compatibility.methods[0]?.observations[0]?.status).toBe(ExecutionStatus.Failed);
}, 60_000);

test("a C# exception counts as entered source and retains failed execution evidence", async () => {
    const directory = await project(
        method("Throw", 'throw new System.InvalidOperationException("Original failure");'),
    );
    const h = await open(directory, {});

    await expect(h.callMethod("Throw")).rejects.toThrow("Original failure");
    expect(h.executions[0]?.calls[0]).toMatchObject({
        executed: true,
        status: ExecutionStatus.Failed,
    });
    const compatibility = await checkCompatibility({ cwd: directory, executions: h.executions });
    expect(compatibility.methods[0]?.executed).toBe(true);
}, 60_000);

test("execution evidence cannot validate changed source and duplicate supplied reports are deduplicated", async () => {
    const directory = await project(method("Current", "return this;"));
    const h = await open(directory, {});
    await h.callMethod("Current");
    const evidence = h.executions;
    const before = await checkCompatibility({
        cwd: directory,
        executions: [...evidence, ...evidence],
    });
    expect(before.methods[0]?.observations).toHaveLength(1);

    await Bun.write(
        join(directory, ".harness/packages/source.xml"),
        `<AML>${schema}${method("Current", 'return this.getInnovator().newResult("Changed source");')}</AML>`,
    );
    const changed = await checkCompatibility({ cwd: directory, executions: evidence });

    expect(changed.methods[0]?.executed).toBe(false);
    expect(changed.methods[0]?.observations).toEqual([]);
    expect(
        changed.issues.some(
            (issue) => issue.code === CompatibilityIssueCode.ExecutionSourceMismatch,
        ),
    ).toBe(true);
}, 60_000);

test("clear only removes execution reports while reset restores configured starting data", async () => {
    const directory = await project();
    const h = await open(directory);
    const record = await h.getOne("TrackedRecord", { name: "Original" });
    await h.update(record, { name: "Changed" });
    const traceLength = h.trace.length;
    const previous = h.executions;

    h.clearExecutions();
    expect(h.executions).toEqual([]);
    expect(h.trace.length).toBe(traceLength);
    expect((await h.getOne("TrackedRecord", { name: "Changed" })).properties.name).toBe("Changed");
    h.reset();
    expect(h.executions).toEqual([]);
    expect((await h.getOne("TrackedRecord", { name: "Original" })).properties.name).toBe(
        "Original",
    );
    expect(previous.length).toBe(2);
});

test("queued requests retain independent inputs and outcomes, and reports survive close", async () => {
    const directory = await project(method("Echo", "adapter", "TestExecutor"));
    const h = await open(directory, {
        csharp: false,
        executors: [
            () => ({
                language: "TestExecutor",

                async execute(_method, context, ports) {
                    ports.executionStarted?.();
                    await Promise.resolve();

                    return new Item({ items: [], result: context.getProperty("value") });
                },
            }),
        ],
    });
    const first = h.callMethod("Echo", { value: "First" });
    const second = h.callMethod("Echo", { value: "Second" });
    expect(() => h.clearExecutions()).toThrow("active operations");
    expect((await first).getResult()).toBe("First");
    expect((await second).getResult()).toBe("Second");

    expect(h.executions.map((run) => run.calls[0]?.result)).toEqual([
        { items: [], result: "First" },
        { items: [], result: "Second" },
    ]);
    expect(new Set(h.executions.map((run) => run.requestId)).size).toBe(2);
    h.close();
    expect(h.executions).toHaveLength(2);
});

test("completed request retention is bounded without mixing identities across worlds or resets", async () => {
    const directory = await project(method("External", "unavailable"), {
        ".harness/mocks.json": JSON.stringify([
            { method: "External", response: { text: "Captured" } },
        ]),
    });
    const h = await open(directory);
    await h.callMethod("External");
    const first = h.executions[0]?.id;

    for (let index = 0; index < 100; index += 1) {
        await h.callMethod("External");
    }

    expect(h.executions).toHaveLength(100);
    expect(h.executions.some((run) => run.id === first)).toBe(false);
    const retained = new Set(h.executions.map((run) => run.id));
    h.reset();
    await h.callMethod("External");
    expect(retained.has(h.executions[0]?.id ?? "")).toBe(false);
    const other = await open(directory);
    await other.callMethod("External");
    expect(other.executions[0]?.id).not.toBe(h.executions[0]?.id);
});

test("serialization, depth and size limits never invoke getters or change handler results", () => {
    const recorder = new ExecutionRecorder({ snapshotBytes: 64, bytes: 128, depth: 2 });
    let getterCalls = 0;
    const input = {
        get value() {
            getterCalls += 1;

            return "Must not read";
        },
    };
    const operation = defineOperation<object, string>("extension.observe");
    const runtime = createRuntime({
        observer: recorder,
        transactions: {
            begin() {},

            commit() {},

            rollback() {},
        },
        modules: [
            {
                id: "extension",

                setup(registrar) {
                    registrar.handleSync(operation, () => "Actual result");
                },
            },
        ],
    });
    expect(runtime.executeSync(operation, input)).toBe("Actual result");
    expect(getterCalls).toBe(0);
    expect(recorder.executions[0]).toMatchObject({
        outcome: ExecutionOutcome.Committed,
        truncated: true,
        omitted: { snapshots: 1 },
    });
    expect(recorder.executions[0]?.calls[0]?.result).toBe("Actual result");
    runtime.close();

    const snapshots = new Snapshots({ bytes: 128, snapshotBytes: 64, depth: 2 });
    const cycle: { self?: object } = {};
    cycle.self = cycle;
    expect(snapshots.value(cycle)).toBeUndefined();
    expect(snapshots.value("x".repeat(100))).toBeUndefined();
    expect(snapshots.value({ a: { b: { c: 1 } } })).toBeUndefined();
    expect(snapshots.omitted).toBe(3);
});

test("call and event limits explicitly mark incomplete reports and compatibility evidence", async () => {
    const recorder = new ExecutionRecorder({ calls: 1, events: 1 });
    const root = { executionId: "1", requestId: "1", operation: "platform.method" };
    recorder.started(root, { name: "Limited" });
    recorder.started(
        { executionId: "2", parentExecutionId: "1", requestId: "1", operation: "platform.apply" },
        {},
    );
    recorder.record({
        sequence: 1,
        executionId: "1",
        requestId: "1",
        kind: "mutation",
        name: "update",
        after: { type: "Record", id: "R", properties: { name: "After" } },
    });
    recorder.record({
        sequence: 2,
        executionId: "1",
        requestId: "1",
        kind: "mutation",
        name: "update",
    });
    recorder.settled("1", "committed");
    const run = recorder.executions[0];

    expect(run).toMatchObject({ truncated: true, omitted: { calls: 1, changes: 1 } });
    expect(run?.changes).toHaveLength(1);
    const directory = await project();
    const compatibility = await checkCompatibility({
        cwd: directory,
        executions: recorder.executions,
    });
    expect(
        compatibility.issues.some(
            (issue) => issue.code === CompatibilityIssueCode.ExecutionEvidenceTruncated,
        ),
    ).toBe(true);
});

test("rollback failures retain an unknown transaction outcome and both original causes", async () => {
    const recorder = new ExecutionRecorder();
    const operation = defineOperation<void, void>("extension.fail");
    const runtime = createRuntime({
        observer: recorder,
        transactions: {
            begin() {},

            commit() {},

            rollback() {
                throw new Error("Rollback unavailable");
            },
        },
        modules: [
            {
                id: "failure",

                setup(registrar) {
                    registrar.handleSync(operation, () => {
                        throw new Error("Original failure");
                    });
                },
            },
        ],
    });

    expect(() => runtime.executeSync(operation, undefined)).toThrow(AggregateError);
    expect(recorder.executions[0]?.outcome).toBe(ExecutionOutcome.Unknown);
    expect(recorder.executions[0]?.error?.causes.map((cause) => cause.message)).toEqual([
        "Original failure",
        "Rollback unavailable",
    ]);
    runtime.close();
});

async function versionedProject(blockPost = false): Promise<string> {
    const lifecycle = `<Item type="Life Cycle Map" action="add" id="CYCLE"><name>Record cycle</name><start_state>DRAFT</start_state><Relationships>
    <Item type="Life Cycle State" action="add" id="DRAFT"><name>Draft</name></Item>
    <Item type="Life Cycle State" action="add" id="REVIEW"><name>Review</name></Item>
    <Item type="Life Cycle Transition" action="add" id="PROMOTE"><from_state>DRAFT</from_state><to_state>REVIEW</to_state>
      ${blockPost ? "<post_action>METHOD_Post</post_action><execute_post_in_main_txn>0</execute_post_in_main_txn>" : ""}
    </Item>
  </Relationships></Item>
  <Item type="ItemType Life Cycle" action="add"><source_id>TRACKED_TYPE</source_id><related_id>CYCLE</related_id></Item>`;
    const directory = await project("", {
        ".harness/packages/source.xml": `<AML>${schema.replace("<is_versionable>0", "<is_versionable>1")}${method("Post", "return this;")}${lifecycle}</AML>`,
        ".harness/fixtures.ts":
            'export default {User: [{login_name: "test.user", created_on: "2026-01-01T00:00:00", created_by_id: {login_name: "test.user"}}], TrackedRecord: [{name: "Original"}]};',
        ".harness/config.ts": 'export default {session: {user: {login_name: "test.user"}}};',
    });

    return directory;
}

function editAndPromote(record: {
    id: string;
    properties: Readonly<Record<string, unknown>>;
}): string {
    return `<AML>
    <Item type="TrackedRecord" action="edit" id="${record.id}"><name>Versioned</name></Item>
    <Item type="TrackedRecord" action="promoteItem" where="config_id='${String(record.properties.config_id)}'"><state>Review</state></Item>
  </AML>`;
}

test("generation creation and lifecycle promotion appear in one committed request", async () => {
    const directory = await versionedProject();
    const h = await open(directory);
    const record = await h.getOne("TrackedRecord", { name: "Original" });
    h.clearExecutions();

    await h.applyAML(editAndPromote(record));
    const run = h.executions.at(-1);
    const version = run?.changes.find((change) => change.name === "version");
    const promotion = run?.changes.find((change) => change.name === "promote");

    expect(run?.outcome).toBe(ExecutionOutcome.Committed);
    expect(run?.calls[0]?.kind).toBe(ExecutionKind.Aml);
    expect(version?.before?.id).toBe(record.id);
    expect(version?.after?.id).not.toBe(record.id);
    expect(version?.after?.properties).toMatchObject({
        config_id: record.properties.config_id,
        generation: 2,
    });
    expect(promotion?.after?.properties).toMatchObject({ state: "Review" });
    expect(run?.changes.every((change) => change.outcome === ExecutionOutcome.Committed)).toBe(
        true,
    );
});

test("lifecycle rejection rolls back a preceding generation and points to the original transition", async () => {
    const directory = await versionedProject(true);
    const h = await open(directory);
    const record = await h.getOne("TrackedRecord", { name: "Original" });
    h.clearExecutions();

    await expect(h.applyAML(editAndPromote(record))).rejects.toMatchObject({
        code: "UnsupportedPostTransactionMethod",
    });
    const run = h.executions.at(-1);

    expect(run?.outcome).toBe(ExecutionOutcome.RolledBack);
    expect(run?.changes.find((change) => change.name === "version")?.outcome).toBe(
        ExecutionOutcome.RolledBack,
    );
    expect(run?.changes.some((change) => change.name === "promote")).toBe(false);
    expect(run?.error).toMatchObject({
        capability: CapabilityId.PostCommitMethods,
        source: { file: join(directory, ".harness/packages/source.xml") },
    });
    expect(run?.error?.source?.path).toEndWith("/Item[3]");
    expect((await h.getOne("TrackedRecord", { name: "Original" })).properties).toMatchObject({
        generation: 1,
        state: "Draft",
    });
});
