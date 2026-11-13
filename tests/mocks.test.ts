import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHarness } from "../src/index.js";
import type { Mock } from "../src/index.js";

const root = Bun.fileURLToPath(new URL("..", import.meta.url));
const directories: string[] = [];
const packages = [
    join(root, ".harness/packages/pipeline/Import"),
    join(root, ".harness/packages/mocks/Import"),
];

afterEach(async () => {
    for (const directory of directories.splice(0)) {
        await rm(directory, { recursive: true, force: true });
    }
});

async function project(mocks: readonly Mock[]): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "harness-mocks-"));
    directories.push(directory);
    await mkdir(join(directory, ".harness/responses"), { recursive: true });
    await Bun.write(
        join(directory, ".harness/config.ts"),
        `export default ${JSON.stringify({
            packages,
            fixtures: [join(root, ".harness/fixtures/baseline.ts")],
        })};`,
    );
    await Bun.write(join(directory, ".harness/mocks.json"), JSON.stringify(mocks));

    return directory;
}

test("shared mocks load automatically and intercept direct and AML calls without an executor", async () => {
    const cwd = await project([
        {
            method: "UninstalledMethod",
            when: { call: "GetActivities" },
            response: "./responses/activities.json",
        },
    ]);
    await Bun.write(
        join(cwd, ".harness/responses/activities.json"),
        '{"activities":[{"name":"Captured activity"}]}',
    );
    using harness = await createHarness({ cwd, csharp: false });

    const direct = await harness.callMethod("UninstalledMethod", { call: "GetActivities" });
    const aml = await harness.applyAML(
        '<Item type="Method" action="UninstalledMethod"><call>GetActivities</call></Item>',
    );

    expect(JSON.parse(direct.getResult())).toEqual({ activities: [{ name: "Captured activity" }] });
    expect(aml.getResult()).toBe(direct.getResult());
    expect((await harness.getOne("TestNode", { name: "Parent" })).properties.count).toBe(9);
    expect(harness.trace.filter((entry) => entry.kind === "method")).toEqual([]);
    expect(harness.trace.filter((entry) => entry.kind === "mock")).toHaveLength(2);
    expect(harness.trace.find((entry) => entry.mock)?.mock?.responseHash).toMatch(/^[a-f0-9]{64}$/);
    await expect(
        harness.callMethod("UninstalledMethod", { call: "SomethingElse" }),
    ).rejects.toThrow("Missing Method");
});

test("per-test overrides replace matching responses while other shared mocks and worlds remain unchanged", async () => {
    const cwd = await project([
        {
            method: "Dispatcher",
            when: { call: "GetActivities" },
            response: { json: { version: "shared" } },
        },
        { method: "Dispatcher", when: { call: "FindRule" }, response: { json: { status: "OK" } } },
    ]);
    using overridden = await createHarness({
        cwd,
        mocks: [
            {
                method: "Dispatcher",
                when: { call: "GetActivities" },
                response: { json: { version: "test" } },
            },
        ],
    });
    using shared = await createHarness({ cwd });

    expect(
        JSON.parse(
            (await overridden.callMethod("Dispatcher", { call: "GetActivities" })).getResult(),
        ),
    ).toEqual({ version: "test" });
    expect(
        JSON.parse((await overridden.callMethod("Dispatcher", { call: "FindRule" })).getResult()),
    ).toEqual({ status: "OK" });
    expect(
        JSON.parse((await shared.callMethod("Dispatcher", { call: "GetActivities" })).getResult()),
    ).toEqual({ version: "shared" });
    using cleared = await createHarness({ cwd, mocks: [] });
    await expect(cleared.callMethod("Dispatcher", { call: "GetActivities" })).rejects.toThrow(
        "Missing Method",
    );
});

test("nested C# calls use configured responses while the calling source and database actions execute", async () => {
    const cwd = await project([
        {
            method: "RecordedLookup",
            when: { name: "Parent" },
            response: { aml: '<Item type="Lookup"><note>Recorded response</note></Item>' },
        },
    ]);
    using harness = await createHarness({ cwd });

    const result = await harness.callMethod("Test_UpdateFromLookup");

    expect(result.isError()).toBe(false);
    expect((await harness.getOne("TestNode", { name: "Parent" })).properties).toMatchObject({
        count: 25,
        note: "Recorded response",
    });
    expect(
        harness.trace.filter((entry) => entry.kind === "method").map((entry) => entry.name),
    ).toEqual(["Test_UpdateFromLookup"]);
    expect(harness.trace.find((entry) => entry.name === "RecordedLookup")?.kind).toBe("mock");
    expect((await harness.callMethod("Test_RealMethod")).getResult()).toBe(
        "Executed original source",
    );
}, 60_000);

test("a mocked business error rolls back earlier writes made by the real calling Method", async () => {
    const cwd = await project([
        { method: "RecordedLookup", response: { error: "Lookup rejected" } },
    ]);
    using harness = await createHarness({ cwd });

    const result = await harness.callMethod("Test_UpdateFromLookup");

    expect(result.getErrorString()).toBe("Lookup rejected");
    expect((await harness.getOne("TestNode", { name: "Parent" })).properties.count).toBe(9);
    expect(harness.trace.find((entry) => entry.name === "RecordedLookup")?.outcome).toBe(
        "rolledBack",
    );
}, 60_000);

test("responses are fresh for every invocation and reset", async () => {
    const cwd = await project([
        { method: "Lookup", response: { aml: '<Item type="Lookup"><note>Original</note></Item>' } },
    ]);
    using harness = await createHarness({ cwd, csharp: false });
    const first = await harness.callMethod("Lookup");
    first.setProperty("note", "Changed by caller");

    expect((await harness.callMethod("Lookup")).getProperty("note")).toBe("Original");
    harness.reset();
    expect(harness.trace).toEqual([]);
    expect((await harness.callMethod("Lookup")).getProperty("note")).toBe("Original");
});

test("specific matches win and equally specific matches report ambiguity", async () => {
    const cwd = await project([
        { method: "Lookup", response: { text: "fallback" } },
        { method: "Lookup", when: { module: "Selected" }, response: { text: "specific" } },
    ]);
    using harness = await createHarness({ cwd, csharp: false });
    expect((await harness.callMethod("Lookup", { module: "Selected" })).getResult()).toBe(
        "specific",
    );
    expect((await harness.callMethod("Lookup", { module: "Other" })).getResult()).toBe("fallback");

    using ambiguous = await createHarness({
        cwd,
        mocks: [
            { method: "Lookup", when: { module: "Selected" }, response: { text: "one" } },
            { method: "Lookup", when: { module: "Selected" }, response: { text: "two" } },
        ],
    });
    await expect(ambiguous.callMethod("Lookup", { module: "Selected" })).rejects.toThrow(
        "Ambiguous method mocks",
    );
});

test("inline SQL and procedure responses return through real C# callers without executing SQL", async () => {
    const cwd = await project([
        {
            sql: true,
            when: { method: "Test_InlineSql" },
            response: { aml: '<Item type="SQL"><name>Parent</name></Item>' },
        },
        {
            sql: "RecordedProcedure",
            when: { ARG1: "Parent" },
            response: { aml: '<Item type="SQL"><name>Procedure response</name></Item>' },
        },
    ]);
    using harness = await createHarness({ cwd });
    expect((await harness.callMethod("Test_InlineSql")).getProperty("name")).toBe("Parent");
    expect((await harness.callMethod("Test_Procedure")).getProperty("name")).toBe(
        "Procedure response",
    );
    expect(
        harness.trace.filter((entry) => entry.kind === "mock").map((entry) => entry.name),
    ).toEqual(["SQL: Test_InlineSql", "SQL Process: RecordedProcedure"]);
}, 60_000);

test("missing response files and invalid mock definitions fail setup with their location", async () => {
    const cwd = await project([{ method: "Lookup", response: "./responses/missing.json" }]);
    await expect(createHarness({ cwd })).rejects.toThrow("missing.json");
    await Bun.write(join(cwd, ".harness/mocks.json"), '[{"method":"Lookup","unknown":true}]');
    await expect(createHarness({ cwd })).rejects.toThrow("mocks.json[0]");
});

test("parameterized SQL preserves its XML parameters and getItemById queries real stored records", async () => {
    const parameters =
        '<Parameters><Parameter name="name" type="string">Parent</Parameter></Parameters>';
    const query = "SELECT id FROM TestNode WHERE name=@name";
    const cwd = await project([
        {
            sql: true,
            when: { method: "Test_ParameterizedSql", parameters, query },
            response: { text: "Captured SQL response" },
        },
    ]);
    using harness = await createHarness({ cwd });
    const parent = await harness.getOne("TestNode", { name: "Parent" });
    const result = await harness.callMethod("Test_ParameterizedSql", {
        record_id: parent.id,
        query,
        parameters,
    });

    expect(result.getID()).toBe(parent.id);
    expect(result.getProperty("count")).toBe("9");
    expect(
        harness.trace.find((event) => event.name === "SQL: Test_ParameterizedSql")?.mock
            ?.parameters,
    ).toMatchObject({ query, parameters });
}, 60_000);

test("event Method mocks resolve imported IDs without replacing the pending request", async () => {
    const cwd = await project([
        {
            method: "Test_BeforeGet",
            response: { aml: '<Item type="TestNode" action="get"><name>Parent</name></Item>' },
        },
    ]);
    const events = join(cwd, ".harness/events.xml");
    await Bun.write(
        events,
        `<AML>
    <Item type="Method" action="add">
      <name>Test_BeforeGet</name>
      <method_type>C#</method_type>
      <method_code>This deliberately cannot compile; the configured mock replaces it.</method_code>
    </Item>
    <Item type="Server Event" action="add">
      <source_id><Item type="ItemType" action="get"><name>TestNode</name></Item></source_id>
      <related_id><Item type="Method" action="get"><name>Test_BeforeGet</name></Item></related_id>
      <server_event>onBeforeGet</server_event>
      <sort_order>10</sort_order>
    </Item>
  </AML>`,
    );
    using harness = await createHarness({ cwd, packages: [...packages, events], csharp: false });

    const found = await harness.getOne("TestNode", { name: "Child" });

    expect(found.properties.name).toBe("Child");
    expect(found.properties.count).toBe(0);
    expect(
        harness.trace.some((entry) => entry.kind === "event" && entry.name === "onBeforeGet"),
    ).toBe(true);
    expect(harness.trace.find((entry) => entry.name === "Test_BeforeGet")?.kind).toBe("mock");
    const direct = await harness.callMethod("Test_BeforeGet", { name: "Child" });

    expect(direct.getProperty("name")).toBe("Parent");
});

test("new harnesses reload edited response files and nested parameter objects remain isolated", async () => {
    const cwd = await project([
        {
            method: "Lookup",
            when: { current: { module: "Selected" } },
            response: "./responses/value.json",
        },
    ]);
    const path = join(cwd, ".harness/responses/value.json");
    await Bun.write(path, '{"value":1}');
    using first = await createHarness({ cwd, csharp: false });
    const parameters = { current: { module: "Selected" } };
    expect(JSON.parse((await first.callMethod("Lookup", parameters)).getResult())).toEqual({
        value: 1,
    });
    expect(parameters).toEqual({ current: { module: "Selected" } });

    await Bun.write(path, '{"value":2}');
    using second = await createHarness({ cwd, csharp: false });
    expect(JSON.parse((await second.callMethod("Lookup", parameters)).getResult())).toEqual({
        value: 2,
    });
    expect(JSON.parse((await first.callMethod("Lookup", parameters)).getResult())).toEqual({
        value: 1,
    });
});
