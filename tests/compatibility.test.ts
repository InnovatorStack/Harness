import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    checkCompatibility,
    createHarness,
    CapabilityId,
    CapabilitySupport,
    CompatibilityIssueCode,
    CompilationStatus,
    ExecutorStatus,
    IssueSeverity,
    MockCoverage,
    PlatformError,
    verifyPackages,
} from "../src/index.js";

const directories: string[] = [];
const schema = `<Item type="ItemType" action="add" id="DOCUMENT_TYPE">
  <name>CompatibilityDocument</name>
  <Relationships>
    <Item type="Property" action="add"><name>name</name><data_type>string</data_type></Item>
  </Relationships>
</Item>`;

function method(name: string, language = "C#", code = "return this;"): string {
    return `<Item type="Method" action="add" id="METHOD_${name}">
    <name>${name}</name><method_type>${language}</method_type>
    <method_code><![CDATA[${code}]]></method_code>
  </Item>`;
}

const sql = `<Item type="SQL" action="add" id="SQL_PROJECTS">
  <name>ListProjects</name><sqlserver_body>SELECT * FROM PROJECTS</sqlserver_body>
</Item>`;

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
});

async function project(files: Readonly<Record<string, string>>): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "harness-compatibility-"));
    directories.push(directory);
    await mkdir(join(directory, ".harness/packages"), { recursive: true });

    for (const [path, contents] of Object.entries(files)) {
        await Bun.write(join(directory, path), contents);
    }

    return directory;
}

test("compatibility reuses configured packages and inventories every declaration without starting setup or extensions", async () => {
    const directory = await project({
        ".harness/config.ts": `export default {
      packages: ["../vendor"], csharp: false,
      modules: [() => { throw new Error("Module must not start"); }],
      executors: [() => { throw new Error("Executor must not start"); }],
    };`,
        ".harness/packages/A/source.xml": `<AML>${method("First", "JavaScript")}${sql}</AML>`,
        "vendor/Z/source.xml": `<AML>${method("Second", "JavaScript")}</AML>`,
        ".harness/fixtures.ts": 'throw new Error("Fixtures must not execute");',
    });

    const report = await checkCompatibility({ cwd: directory, compile: true });

    expect(report.packages).toEqual(await verifyPackages({ cwd: directory }));
    expect(report.packages.canImport).toBe(true);
    expect(report.methods.map((entry) => entry.definition?.name)).toEqual(["First", "Second"]);
    expect(report.methods.every((entry) => entry.executor.status === ExecutorStatus.Unknown)).toBe(
        true,
    );
    expect(report.methods.every((entry) => !entry.executed && !entry.referenceVerified)).toBe(true);
    expect(report.sql).toHaveLength(1);
    expect(
        report.issues.some((entry) => entry.code === CompatibilityIssueCode.ExtensionNotInspected),
    ).toBe(true);
});

test("capabilities have stable IDs, valid dependencies, explicit limitations and no invented native evidence", async () => {
    const directory = await project({});
    const report = await checkCompatibility({ cwd: directory });
    const ids = new Set(report.capabilities.map((entry) => entry.id));

    expect(ids.size).toBe(Object.values(CapabilityId).length);
    expect(
        report.capabilities.every((entry) =>
            entry.dependsOn.every((dependency) => ids.has(dependency)),
        ),
    ).toBe(true);
    expect(report.capabilities.every((entry) => !entry.referenceVerified)).toBe(true);
    expect(
        report.capabilities.find((entry) => entry.id === CapabilityId.Generations),
    ).toMatchObject({
        support: CapabilitySupport.Partial,
    });
    expect(report.capabilities.find((entry) => entry.id === CapabilityId.TSql)).toMatchObject({
        support: CapabilitySupport.Unsupported,
    });
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.capabilities[0]?.limitations)).toBe(true);
    expect(report.issues).toEqual([]);
});

test("unconditional mocks bypass unavailable SDKs, assemblies and malformed source even when compilation is requested", async () => {
    const directory = await project({
        ".harness/config.ts": `export default { csharp: {dotnet: "missing-managed-sdk", references: ["./missing.dll"], cacheDirectory: "./cache"} };`,
        ".harness/packages/source.xml": `<AML>${method("External", "C#", "This cannot compile")}</AML>`,
        ".harness/mocks.json": JSON.stringify([
            { method: "external", response: { text: "Captured response" } },
        ]),
    });

    const report = await checkCompatibility({ cwd: directory, compile: true });

    expect(report.methods[0]?.mocks.coverage).toBe(MockCoverage.Unconditional);
    expect(report.methods[0]?.compilation.status).toBe(CompilationStatus.SkippedMock);
    expect(report.methods[0]?.executor.status).toBe(ExecutorStatus.Unknown);
    expect(report.issues).toEqual([]);
    expect(await Bun.file(join(directory, ".harness/cache")).exists()).toBe(false);
    using harness = await createHarness({ cwd: directory });
    expect((await harness.callMethod("External")).getResult()).toBe("Captured response");
});

test("conditional mocks leave the underlying executor requirement visible", async () => {
    const directory = await project({
        ".harness/packages/source.xml": `<AML>${method("Conditional")}</AML>`,
        ".harness/mocks.json": JSON.stringify([
            { method: "Conditional", when: { kind: "Chosen" }, response: { text: "Match" } },
        ]),
    });

    const report = await checkCompatibility({ cwd: directory, csharp: false, compile: true });

    expect(report.methods[0]?.mocks.coverage).toBe(MockCoverage.Conditional);
    expect(report.methods[0]?.executor.status).toBe(ExecutorStatus.Disabled);
    expect(report.methods[0]?.compilation.status).toBe(CompilationStatus.Unavailable);
    expect(report.methods[0]?.issues.map((issue) => issue.code)).toEqual([
        CompatibilityIssueCode.ConditionalMock,
        CompatibilityIssueCode.ExecutorUnavailable,
    ]);
});

test("shared mocks, per-test overrides and explicit clearing use the actual runtime precedence", async () => {
    const directory = await project({
        ".harness/packages/source.xml": `<AML>${method("External")}${sql}</AML>`,
        ".harness/mocks.json": JSON.stringify([
            { method: "External", response: { text: "Shared" } },
            { sql: "ListProjects", response: { text: "Projects" } },
        ]),
    });
    const overridden = await checkCompatibility({
        cwd: directory,
        csharp: false,
        mocks: [{ method: "External", when: { kind: "Local" }, response: { text: "Local" } }],
    });
    expect(overridden.methods[0]?.mocks.coverage).toBe(MockCoverage.Unconditional);
    expect(overridden.methods[0]?.mocks.rules.map((rule) => rule.layer)).toEqual([0, 1]);
    expect(overridden.sql[0]?.mocks.coverage).toBe(MockCoverage.Unconditional);

    const cleared = await checkCompatibility({ cwd: directory, csharp: false, mocks: [] });
    expect(cleared.methods[0]?.mocks.coverage).toBe(MockCoverage.None);
    expect(cleared.sql[0]?.mocks.coverage).toBe(MockCoverage.None);
    expect(cleared.issues.some((entry) => entry.causeCode === "UnsupportedSQL")).toBe(true);
});

test("named SQL mocks do not claim coverage for inline queries or different procedure parameters", async () => {
    const directory = await project({
        ".harness/packages/source.xml": `<AML>${sql}</AML>`,
        ".harness/mocks.json": JSON.stringify([
            { sql: true, when: { method: "Caller" }, response: { text: "Inline" } },
            {
                sql: "ListProjects",
                when: { project: "Chosen" },
                response: { text: "Chosen project" },
            },
        ]),
    });
    const report = await checkCompatibility({ cwd: directory });

    expect(report.sql[0]?.mocks.coverage).toBe(MockCoverage.Conditional);
    expect(report.sql[0]?.mocks.rules).toHaveLength(1);
    expect(report.sql[0]?.executor.status).toBe(ExecutorStatus.Missing);
    expect(report.sql[0]?.issues.some((entry) => entry.capability === CapabilityId.TSql)).toBe(
        true,
    );
    expect(report.sql[0]?.executed).toBe(false);
});

test("ambiguous unconditional mocks are reported without selecting a pretend response", async () => {
    const directory = await project({
        ".harness/packages/source.xml": `<AML>${method("External")}</AML>`,
    });
    const mocks = [
        { method: "External", response: { text: "One" } },
        { method: "METHOD_External", response: { text: "Two" } },
    ];
    const report = await checkCompatibility({
        cwd: directory,
        csharp: false,
        compile: true,
        mocks,
    });

    expect(report.methods[0]?.mocks.coverage).toBe(MockCoverage.Ambiguous);
    expect(report.methods[0]?.compilation.status).toBe(CompilationStatus.Unavailable);
    expect(report.issues.some((entry) => entry.code === CompatibilityIssueCode.AmbiguousMock)).toBe(
        true,
    );
    using harness = await createHarness({ cwd: directory, csharp: false, mocks });
    await expect(harness.callMethod("External")).rejects.toThrow("Ambiguous");
});

test("invalid response files retain the full inventory and prevent compilation claims", async () => {
    const directory = await project({
        ".harness/packages/source.xml": `<AML>${method("External")}${sql}</AML>`,
        ".harness/mocks.json": JSON.stringify([
            { method: "External", response: "./responses/missing.json" },
        ]),
    });
    const report = await checkCompatibility({ cwd: directory, csharp: false, compile: true });

    expect(report.packages.canImport).toBe(true);
    expect(report.methods).toHaveLength(1);
    expect(report.sql).toHaveLength(1);
    expect(report.methods[0]?.mocks.coverage).toBe(MockCoverage.Unknown);
    expect(report.methods[0]?.compilation.status).toBe(CompilationStatus.Unavailable);
    expect(
        report.issues.find((entry) => entry.code === CompatibilityIssueCode.InvalidMocks)?.message,
    ).toContain("missing.json");
});

test("executor availability distinguishes disabled, missing and unavailable runtimes", async () => {
    const directory = await project({
        ".harness/packages/source.xml": `<AML>${method("Managed")}${method("Browser", "JavaScript")}</AML>`,
    });
    const disabled = await checkCompatibility({ cwd: directory, csharp: false });
    expect(disabled.methods.map((entry) => entry.executor.status)).toEqual([
        ExecutorStatus.Disabled,
        ExecutorStatus.Missing,
    ]);

    const missingSdk = await checkCompatibility({
        cwd: directory,
        csharp: { dotnet: "missing-managed-sdk" },
    });
    expect(missingSdk.methods[0]?.executor.status).toBe(ExecutorStatus.Unavailable);
    expect(missingSdk.methods[0]?.compilation.status).toBe(CompilationStatus.NotRequested);
    expect(
        missingSdk.issues.find((entry) => entry.capability === CapabilityId.CSharp)?.source?.file,
    ).toEndWith("source.xml");
});

test("configured assembly paths are resolved relative to the harness config", async () => {
    const directory = await project({
        ".harness/config.ts": 'export default {csharp: {references: ["./references/absent.dll"]}};',
        ".harness/packages/source.xml": `<AML>${method("Managed")}</AML>`,
    });
    const report = await checkCompatibility({ cwd: directory });

    expect(report.methods[0]?.executor.status).toBe(ExecutorStatus.Unavailable);
    expect(report.methods[0]?.executor.message).toContain(
        join(directory, ".harness/references/absent.dll"),
    );
});

test("unsupported event versions are detected before invocation and share the runtime capability ID", async () => {
    const directory = await project({
        ".harness/packages/events.xml": `<AML>${schema}${method("BeforeAdd", "JavaScript")}
      <Item type="Server Event" action="add" id="EVENT">
        <source_id>DOCUMENT_TYPE</source_id><related_id>METHOD_BeforeAdd</related_id>
        <server_event>onBeforeAdd</server_event><event_version>version_2</event_version>
      </Item>
    </AML>`,
    });
    const mocks = [{ method: "BeforeAdd", response: { text: "Unused" } }];
    const report = await checkCompatibility({ cwd: directory, csharp: false, mocks });
    const diagnostic = report.issues.find((entry) => entry.causeCode === "UnsupportedEventVersion");

    expect(report.packages.canImport).toBe(true);
    expect(diagnostic).toMatchObject({
        capability: CapabilityId.CollectionEvents,
        source: { file: join(directory, ".harness/packages/events.xml") },
    });
    using harness = await createHarness({ cwd: directory, csharp: false, mocks });

    try {
        await harness.add("CompatibilityDocument", { name: "Fails before hook" });

        throw new Error("Unsupported event unexpectedly executed");
    } catch (error) {
        expect(error).toBeInstanceOf(PlatformError);

        if (error instanceof PlatformError) {
            expect(error).toMatchObject({
                code: diagnostic?.causeCode,
                capability: diagnostic?.capability,
            });
        }
    }
});

test("tied event ordering remains a gap while state-action replacement bindings are supported", async () => {
    const directory = await project({
        ".harness/packages/events.xml": `<AML>${schema}${method("Handler", "JavaScript")}
      <Item type="Server Event" action="add" id="EVENT_A"><source_id>DOCUMENT_TYPE</source_id><related_id>METHOD_Handler</related_id><server_event>onBeforeGet</server_event><sort_order>10</sort_order></Item>
      <Item type="Server Event" action="add" id="EVENT_B"><source_id>DOCUMENT_TYPE</source_id><related_id>METHOD_Handler</related_id><server_event>onBeforeGet</server_event><sort_order>10</sort_order></Item>
      <Item type="Server Event" action="add" id="EVENT_C"><source_id>DOCUMENT_TYPE</source_id><related_id>METHOD_Handler</related_id><server_event>onPromote</server_event></Item>
    </AML>`,
    });
    const report = await checkCompatibility({ cwd: directory, csharp: false });

    expect(report.issues.some((entry) => entry.causeCode === "AmbiguousEventOrder")).toBe(true);
    expect(
        report.issues.some((entry) => entry.capability === CapabilityId.StateActionReplacement),
    ).toBe(false);
});

test("lifecycle metadata exposes nontransactional post Methods and workflow startup", async () => {
    const directory = await project({
        ".harness/packages/lifecycle.xml": `<AML>${schema}${method("Post", "JavaScript")}
      <Item type="Workflow Map" action="add" id="WORKFLOW"><name>Review process</name></Item>
      <Item type="Life Cycle Map" action="add" id="CYCLE"><name>Review</name><start_state>DRAFT</start_state><Relationships>
        <Item type="Life Cycle State" action="add" id="DRAFT"><name>Draft</name></Item>
        <Item type="Life Cycle State" action="add" id="REVIEW"><name>Review</name><workflow>WORKFLOW</workflow></Item>
        <Item type="Life Cycle Transition" action="add" id="SEND"><from_state>DRAFT</from_state><to_state>REVIEW</to_state><post_action>METHOD_Post</post_action><execute_post_in_main_txn>0</execute_post_in_main_txn></Item>
      </Relationships></Item>
      <Item type="ItemType Life Cycle" action="add"><source_id>DOCUMENT_TYPE</source_id><related_id>CYCLE</related_id></Item>
    </AML>`,
    });
    const report = await checkCompatibility({ cwd: directory, csharp: false });

    expect(report.packages.issues).toEqual([]);
    expect(report.issues.some((entry) => entry.capability === CapabilityId.PostCommitMethods)).toBe(
        true,
    );
    expect(report.issues.some((entry) => entry.capability === CapabilityId.Workflow)).toBe(true);
});

test.each(["polymorphic", "federated"])(
    "%s metadata imports without claiming an execution adapter",
    async (implementation) => {
        const directory = await project({
            ".harness/packages/external.xml": `<Item type="ItemType" action="add" id="EXTERNAL"><name>ExternalRecord</name><implementation_type>${implementation}</implementation_type></Item>`,
        });
        const report = await checkCompatibility({ cwd: directory });

        expect(report.packages.canImport).toBe(true);
        expect(
            report.issues.find((entry) => entry.causeCode === "UnsupportedImplementation")
                ?.capability,
        ).toBe(
            implementation === "polymorphic" ? CapabilityId.Polymorphism : CapabilityId.Federation,
        );
        using harness = await createHarness({ cwd: directory, csharp: false });
        await expect(harness.get("ExternalRecord")).rejects.toMatchObject({
            code: "UnsupportedImplementation",
            capability:
                implementation === "polymorphic"
                    ? CapabilityId.Polymorphism
                    : CapabilityId.Federation,
        });
    },
);

test("authorization requirements are separate from explicit unchecked execution", async () => {
    const directory = await project({
        ".harness/packages/source.xml": `<AML>${method("Restricted", "JavaScript")}
      <Item type="Method" action="edit" id="METHOD_Restricted"><execution_allowed_to><Item type="Identity" action="get"><name>World</name></Item></execution_allowed_to></Item>
    </AML>`,
    });
    const restricted = await checkCompatibility({ cwd: directory });
    expect(restricted.packages.issues).toEqual([]);
    expect(
        restricted.issues.some(
            (entry) => entry.code === CompatibilityIssueCode.AuthorizationRequired,
        ),
    ).toBe(true);

    const unchecked = await checkCompatibility({ cwd: directory, authorization: "unchecked" });
    expect(
        unchecked.issues.some(
            (entry) => entry.code === CompatibilityIssueCode.AuthorizationRequired,
        ),
    ).toBe(false);
    expect(
        unchecked.issues.find((entry) => entry.capability === CapabilityId.NativePermissions)
            ?.severity,
    ).toBe(IssueSeverity.Information);
});

test("package failures retain every declaration without probing source whose metadata is unresolved", async () => {
    const directory = await project({
        ".harness/config.ts": 'export default {csharp: {dotnet: "missing-managed-sdk"}};',
        ".harness/packages/source.xml": `<AML>${method("Managed")}${sql}<Item type="MissingType" action="add" id="RECORD" /></AML>`,
    });
    const report = await checkCompatibility({ cwd: directory, compile: true });

    expect(report.packages.canImport).toBe(false);
    expect(report.methods).toHaveLength(1);
    expect(report.sql).toHaveLength(1);
    expect(report.methods[0]?.definition).toBeUndefined();
    expect(report.methods[0]?.executor.status).toBe(ExecutorStatus.Unknown);
    expect(report.methods[0]?.compilation.status).toBe(CompilationStatus.Unresolved);
    expect(
        report.issues.some((entry) => entry.code === CompatibilityIssueCode.PackageImportFailed),
    ).toBe(true);
});

test("renamed declarations use effective names when assessing mocks", async () => {
    const directory = await project({
        ".harness/packages/source.xml": `<AML>${method("Original")}
      <Item type="Method" action="edit" id="METHOD_Original"><name>Renamed</name></Item>
    </AML>`,
        ".harness/mocks.json": JSON.stringify([
            { method: "Original", response: { text: "Obsolete name" } },
        ]),
    });
    const report = await checkCompatibility({ cwd: directory, csharp: false });

    expect(report.methods).toHaveLength(2);
    expect(report.methods.every((entry) => entry.definition?.name === "Renamed")).toBe(true);
    expect(report.methods.every((entry) => entry.mocks.coverage === MockCoverage.None)).toBe(true);
});

test("successive reports reload package source and response files without leaking inspection state", async () => {
    const directory = await project({
        ".harness/packages/source.xml": `<AML>${method("Reloaded")}</AML>`,
        ".harness/mocks.json": JSON.stringify([
            { method: "Reloaded", response: "./responses/value.txt" },
        ]),
        ".harness/responses/value.txt": "First",
    });
    const first = await checkCompatibility({ cwd: directory });
    await Bun.write(join(directory, ".harness/responses/value.txt"), "Second");
    await Bun.write(
        join(directory, ".harness/packages/source.xml"),
        `<AML>${method("Reloaded", "JavaScript")}</AML>`,
    );
    const second = await checkCompatibility({ cwd: directory });

    expect(first.methods[0]?.mocks.rules[0]?.responseHash).not.toBe(
        second.methods[0]?.mocks.rules[0]?.responseHash,
    );
    expect(first.methods[0]?.definition?.language).toBe("C#");
    expect(second.methods[0]?.definition?.language).toBe("JavaScript");
    expect(second.methods[0]?.compilation.status).toBe(CompilationStatus.SkippedMock);
});

test("optional compilation uses real effective C# source and reports compiler failures without executing it", async () => {
    const directory = await project({});
    const marker = join(directory, "business-code-executed.txt");
    const validCode = `System.IO.File.WriteAllText(@"${marker}", "Must not execute"); return this;`;
    const invalidCode = "return anUndefinedValue;";
    await Bun.write(
        join(directory, ".harness/packages/source.xml"),
        `<AML>${method("Safe", "C#", validCode)}${method("Broken", "C#", invalidCode)}</AML>`,
    );

    const defaultReport = await checkCompatibility({ cwd: directory });
    expect(
        defaultReport.methods.every(
            (entry) => entry.compilation.status === CompilationStatus.NotRequested,
        ),
    ).toBe(true);
    const report = await checkCompatibility({ cwd: directory, compile: true });

    expect(report.methods[0]?.executor.status).toBe(ExecutorStatus.Available);
    expect(report.methods[0]?.compilation).toMatchObject({
        status: CompilationStatus.Compiled,
        sourceHash: new Bun.CryptoHasher("sha256").update(validCode).digest("hex"),
    });
    expect(report.methods[1]?.compilation.status).toBe(CompilationStatus.Failed);
    expect(report.methods[1]?.issues[0]?.code).toBe(CompatibilityIssueCode.CompilationFailed);
    expect(report.methods[1]?.compilation.message).toContain("anUndefinedValue");
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(report.methods.every((entry) => !entry.executed)).toBe(true);
}, 60_000);

test("compilation labels the effective patched hash rather than the overwritten declaration", async () => {
    const code = "return this;";
    const directory = await project({
        ".harness/packages/source.xml": `<AML>${method("Patched", "C#", "invalid original body")}
      <Item type="Method" action="edit" id="METHOD_Patched"><method_code><![CDATA[${code}]]></method_code></Item>
    </AML>`,
    });
    const report = await checkCompatibility({ cwd: directory, compile: true });
    const hash = new Bun.CryptoHasher("sha256").update(code).digest("hex");

    expect(report.methods).toHaveLength(2);
    expect(report.methods[0]?.declaration.codeHash).not.toBe(hash);
    expect(
        report.methods.every(
            (entry) =>
                entry.compilation.status === CompilationStatus.Compiled &&
                entry.compilation.sourceHash === hash,
        ),
    ).toBe(true);
    expect(report.issues).toEqual([]);
}, 60_000);

test("a directory cannot satisfy a configured assembly reference", async () => {
    const directory = await project({
        ".harness/packages/source.xml": `<AML>${method("Managed")}</AML>`,
    });
    await mkdir(join(directory, ".harness/references/not-an-assembly.dll"), { recursive: true });

    const report = await checkCompatibility({
        cwd: directory,
        csharp: { references: ["./references/not-an-assembly.dll"] },
        compile: true,
    });

    expect(report.methods[0]?.executor.status).toBe(ExecutorStatus.Unavailable);
    expect(report.methods[0]?.compilation.status).toBe(CompilationStatus.Unavailable);
    expect(report.methods[0]?.executor.message).toContain("not-an-assembly.dll");
});

test("deleted Method declarations remain inventoried without a compilation claim", async () => {
    const directory = await project({
        ".harness/packages/source.xml": `<AML>${method("Removed")}<Item type="Method" action="delete" id="METHOD_Removed" /></AML>`,
    });
    const report = await checkCompatibility({ cwd: directory, compile: true });

    expect(report.packages.canImport).toBe(true);
    expect(report.methods).toHaveLength(1);
    expect(report.methods[0]?.definition).toBeUndefined();
    expect(report.methods[0]?.compilation.status).toBe(CompilationStatus.Unresolved);
    expect(report.methods[0]?.executor.status).toBe(ExecutorStatus.Unknown);
});

test("fully mocked definitions do not require a Method body or language", async () => {
    const directory = await project({
        ".harness/packages/source.xml":
            '<Item type="Method" action="add" id="EXTERNAL"><name>External</name></Item>',
    });
    const report = await checkCompatibility({
        cwd: directory,
        compile: true,
        mocks: [{ method: "External", response: { text: "Captured" } }],
    });

    expect(report.packages.canImport).toBe(true);
    expect(report.methods[0]?.compilation.status).toBe(CompilationStatus.SkippedMock);
    expect(report.issues).toEqual([]);
});

test("invalid shared configuration returns typed package diagnostics", async () => {
    const directory = await project({
        ".harness/config.ts": "export default {unknownOption: true};",
    });
    const report = await checkCompatibility({ cwd: directory });

    expect(report.packages.canImport).toBe(false);
    expect(report.packages.issues[0]?.message).toContain("unknownOption");
    expect(report.issues[0]?.code).toBe(CompatibilityIssueCode.PackageImportFailed);
    expect(report.methods).toEqual([]);
    expect(report.capabilities.length).toBe(Object.values(CapabilityId).length);
});

test("missing executors and SQL execution expose the same capability IDs before and during execution", async () => {
    const directory = await project({
        ".harness/packages/source.xml": `<AML>${method("Browser", "JavaScript")}${sql}</AML>`,
    });
    const report = await checkCompatibility({ cwd: directory, csharp: false });
    using harness = await createHarness({ cwd: directory, csharp: false });

    expect(report.methods[0]?.issues[0]?.capability).toBe(CapabilityId.JavaScript);
    await expect(harness.callMethod("Browser")).rejects.toMatchObject({
        code: "MissingExecutor",
        capability: CapabilityId.JavaScript,
    });
    expect(report.sql[0]?.issues[0]?.capability).toBe(CapabilityId.TSql);
    await expect(
        harness.applyAML('<Item type="SQL" action="SQL Process"><name>ListProjects</name></Item>'),
    ).rejects.toMatchObject({ code: "UnsupportedSQL", capability: CapabilityId.TSql });
});
