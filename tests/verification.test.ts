import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHarness, verifyPackages, PackageIssueCode } from "../src/index.js";

const directories: string[] = [];
const schema = `<Item type="ItemType" action="add" id="RECORD_TYPE">
  <name>VerificationRecord</name>
  <Relationships>
    <Item type="Property" action="add" id="RECORD_NAME">
      <name>name</name><data_type>string</data_type>
    </Item>
    <Item type="Property" action="add" id="RECORD_OWNER">
      <name>owner</name><data_type>item</data_type>
      <data_source><Item type="ItemType" action="get"><name>Identity</name></Item></data_source>
    </Item>
  </Relationships>
</Item>`;

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
});

async function project(files: Readonly<Record<string, string | Uint8Array>>): Promise<string> {
    const temporary = await mkdtemp(join(tmpdir(), "harness-verification-"));
    directories.push(temporary);
    const directory = await realpath(temporary);
    await mkdir(join(directory, ".harness/packages"), { recursive: true });

    for (const [path, contents] of Object.entries(files)) {
        await Bun.write(join(directory, path), contents);
    }

    return directory;
}

test("verification shares automatic and relative package discovery with normal world creation", async () => {
    const directory = await project({
        ".harness/config.ts": 'export default { packages: ["../vendor"] };',
        ".harness/packages/A/data.xml":
            '<Item type="VerificationRecord" action="add" id="RECORD"><name>First</name></Item>',
        "vendor/Z/schema.xml": `<AML>${schema}</AML>`,
    });
    await mkdir(join(directory, "tests/nested"), { recursive: true });

    const report = await verifyPackages({ cwd: join(directory, "tests/nested") });

    expect(report.canImport).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.documents.map((document) => document.path)).toEqual([
        join(directory, ".harness/packages/A/data.xml"),
        join(directory, "vendor/Z/schema.xml"),
    ]);
    using harness = await createHarness({ cwd: directory, csharp: false });
    expect((await harness.getOne("VerificationRecord", { name: "First" })).id).toBe("RECORD");
});

test("verification inventories nested Method and SQL declarations without executing setup or source", async () => {
    const code = "  this cannot compile;\r\n";
    const sql = "SELECT FROM invalid SQL;";
    const input = `<AML>${schema}
    <Item type="Server Event" action="add" id="EVENT">
      <source_id>RECORD_TYPE</source_id>
      <server_event>onBeforeAdd</server_event>
      <related_id>
        <Item type="Method" action="add" id="METHOD">
          <name>UncompiledMethod</name><method_type>C#</method_type>
          <method_code><![CDATA[${code}]]></method_code>
        </Item>
      </related_id>
    </Item>
    <Item type="SQL" action="add" id="SQL">
      <name>UnexecutedSql</name><sqlserver_body><![CDATA[${sql}]]></sqlserver_body>
    </Item>
  </AML>`;
    const directory = await project({
        ".harness/packages/Example/source.xml": input,
        ".harness/fixtures.ts":
            'throw new Error("Fixtures must not execute during package verification");',
        ".harness/config.ts": `export default {
      csharp: { dotnet: "unavailable-dotnet", references: ["./missing.dll"] },
      modules: [() => { throw new Error("Module factory executed"); }],
      executors: [() => { throw new Error("Executor factory executed"); }],
      mocks: [{ method: "UncompiledMethod", response: "./missing-response.xml" }],
    };`,
    });

    const report = await verifyPackages({ cwd: directory });

    expect(report.canImport).toBe(true);
    expect(report.methods).toHaveLength(1);
    expect(report.methods[0]).toMatchObject({
        id: "METHOD",
        name: "UncompiledMethod",
        language: "C#",
        codeHash: new Bun.CryptoHasher("sha256").update(code).digest("hex"),
        source: { file: join(directory, ".harness/packages/Example/source.xml") },
    });
    expect(report.sql).toHaveLength(1);
    expect(report.sql[0]?.bodyHashes.sqlserver_body).toBe(
        new Bun.CryptoHasher("sha256").update(sql).digest("hex"),
    );
    expect(report.documents[0]?.sha256).toBe(
        new Bun.CryptoHasher("sha256").update(input).digest("hex"),
    );
    expect(await Bun.file(join(directory, ".harness/packages/Example/source.xml")).text()).toBe(
        input,
    );
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.methods)).toBe(true);
});

test("Method selectors are references and patches remain visible as separate source declarations", async () => {
    const directory = await project({
        ".harness/packages/Example/patches.xml": `<AML>
      <Item type="Method" action="add" id="METHOD">
        <name>Original</name><method_type>JavaScript</method_type><method_code>return this;</method_code>
      </Item>
      <Item type="Method" action="edit" id="METHOD"><name>Renamed</name></Item>
      <Item type="Method" action="get"><name>Renamed</name></Item>
    </AML>`,
    });

    const report = await verifyPackages({ cwd: directory });

    expect(report.canImport).toBe(true);
    expect(report.methods.map((method) => [method.action, method.name])).toEqual([
        ["add", "Original"],
        ["edit", "Renamed"],
    ]);
    expect(report.methods[1]?.codeHash).toBeUndefined();
});

test("package verification ignores fixture data when reporting missing package dependencies", async () => {
    const directory = await project({
        ".harness/packages/Example/source.xml": `<AML>${schema}
      <Item type="VerificationRecord" action="add" id="RECORD">
        <name>Needs identity</name><owner>FIXTURE_IDENTITY</owner>
      </Item>
    </AML>`,
        ".harness/fixtures/identity.xml":
            '<Item type="Identity" action="add" id="FIXTURE_IDENTITY"><name>Scenario identity</name></Item>',
    });

    const report = await verifyPackages({ cwd: directory });

    expect(report.canImport).toBe(false);
    expect(report.issues[0]).toMatchObject({
        code: PackageIssueCode.MissingDependency,
        reference: { type: "Identity", id: "FIXTURE_IDENTITY" },
    });
    using harness = await createHarness({ cwd: directory, csharp: false });
    expect((await harness.getOne("VerificationRecord", { id: "RECORD" })).properties.owner).toBe(
        "FIXTURE_IDENTITY",
    );
});

test("missing typed references retain their target and exact referring XML location", async () => {
    const directory = await project({
        ".harness/packages/Example/source.xml": `<AML>
      <Item type="Identity" action="add" id="GROUP">
        <name>Group</name>
        <Relationships>
          <Item type="Member" action="add" id="MEMBER">
            <related_id type="Identity">MISSING_IDENTITY</related_id>
          </Item>
        </Relationships>
      </Item>
    </AML>`,
    });

    const report = await verifyPackages({ cwd: directory });
    const issue = report.issues.find((entry) => entry.reference?.id === "MISSING_IDENTITY");

    expect(report.canImport).toBe(false);
    expect(issue).toMatchObject({
        code: PackageIssueCode.MissingDependency,
        causeCode: "MISSING_REFERENCE",
        reference: { type: "Identity", id: "MISSING_IDENTITY" },
        source: { file: join(directory, ".harness/packages/Example/source.xml"), line: 6 },
    });
    expect(issue?.source?.path).toEndWith("/related_id[1]");
});

test("missing nested selectors retain the original query and Method inventory", async () => {
    const directory = await project({
        ".harness/packages/Example/source.xml": `<AML>
      <Item type="Method" action="add" id="METHOD">
        <name>Dependent</name><method_type>C#</method_type><method_code>return this;</method_code>
        <execution_allowed_to><Item type="Identity" action="get"><name>MissingRole</name></Item></execution_allowed_to>
      </Item>
    </AML>`,
    });

    const report = await verifyPackages({ cwd: directory });
    const issue = report.issues.find((entry) => entry.reference?.selector);

    expect(report.canImport).toBe(false);
    expect(report.methods.map((method) => method.name)).toEqual(["Dependent"]);
    expect(issue).toMatchObject({
        code: PackageIssueCode.MissingDependency,
        reference: {
            type: "Identity",
            selector: { attributes: { action: "get", type: "Identity" } },
        },
    });
});

test("missing ItemType definitions are reported as named dependencies", async () => {
    const directory = await project({
        ".harness/packages/Example/data.xml":
            '<Item type="MissingType" action="add" id="RECORD" />',
    });

    const report = await verifyPackages({ cwd: directory });

    expect(report.canImport).toBe(false);
    expect(report.issues).toEqual([
        expect.objectContaining({
            code: PackageIssueCode.MissingDependency,
            reference: { type: "ItemType", name: "MissingType" },
        }),
    ]);
});

test("conflicting definitions identify both source files", async () => {
    const directory = await project({
        ".harness/packages/A/data.xml":
            '<Item type="Identity" action="add" id="CONFLICT"><name>First</name></Item>',
        ".harness/packages/B/data.xml":
            '<Item type="Identity" action="add" id="CONFLICT"><name>Second</name></Item>',
    });

    const report = await verifyPackages({ cwd: directory });
    const issue = report.issues.find((entry) => entry.code === PackageIssueCode.Conflict);

    expect(report.canImport).toBe(false);
    expect(issue?.source?.file).toBe(join(directory, ".harness/packages/B/data.xml"));
    expect(issue?.relatedSources.map((source) => source.file)).toContain(
        join(directory, ".harness/packages/A/data.xml"),
    );
});

test("verification preserves each file's action sequence", async () => {
    const directory = await project({
        ".harness/packages/Example/data.xml": `<AML>
      <Item type="Identity" action="edit" id="LATER"><name>Too early</name></Item>
      <Item type="Identity" action="add" id="LATER"><name>Later</name></Item>
    </AML>`,
    });

    const report = await verifyPackages({ cwd: directory });

    expect(report.canImport).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toContain(PackageIssueCode.Conflict);
});

test("an unavailable storage implementation is a Harness capability issue", async () => {
    const directory = await project({
        ".harness/packages/Example/schema.xml":
            '<Item type="ItemType" action="add" id="EXTERNAL"><name>External</name><implementation_type>external-adapter</implementation_type></Item>',
    });

    const report = await verifyPackages({ cwd: directory });

    expect(report.canImport).toBe(false);
    expect(report.issues).toEqual([
        expect.objectContaining({
            code: PackageIssueCode.UnsupportedFeature,
            causeCode: "UNSUPPORTED_IMPLEMENTATION",
        }),
    ]);
});

test("invalid XML and encoding do not hide independent readable Method declarations", async () => {
    const directory = await project({
        ".harness/packages/Example/A.xml": '<AML><Item type="Identity"></AML>',
        ".harness/packages/Example/B.xml": new Uint8Array([0xff, 0xfe]),
        ".harness/packages/Example/C.xml":
            '<Item type="Method" action="add" id="METHOD"><name>Readable</name></Item>',
    });

    const report = await verifyPackages({ cwd: directory });

    expect(report.canImport).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toEqual([
        PackageIssueCode.InvalidXml,
        PackageIssueCode.InvalidInput,
    ]);
    expect(report.methods.map((method) => method.name)).toEqual(["Readable"]);
    expect(report.documents).toHaveLength(1);
});

test("missing and empty additional paths are collected alongside the automatic packages", async () => {
    const directory = await project({
        ".harness/config.ts":
            'export default { packages: ["../missing-one", "../missing-two", "../empty"] };',
        ".harness/packages/Example/source.xml":
            '<Item type="Method" action="add" id="METHOD"><name>Automatic</name></Item>',
    });
    await mkdir(join(directory, "empty"));

    const report = await verifyPackages({ cwd: directory });

    expect(report.canImport).toBe(false);
    expect(report.issues).toHaveLength(3);
    expect(report.issues.every((issue) => issue.code === PackageIssueCode.InvalidInput)).toBe(true);
    expect(report.methods.map((method) => method.name)).toEqual(["Automatic"]);
});

test("a rejected symlink does not hide readable sibling files", async () => {
    const directory = await project({
        "outside.xml":
            '<Item type="Identity" action="add" id="OUTSIDE"><name>Outside</name></Item>',
        ".harness/packages/Z.xml":
            '<Item type="Method" action="add" id="METHOD"><name>Readable</name></Item>',
    });
    await symlink(join(directory, "outside.xml"), join(directory, ".harness/packages/A.xml"));

    const report = await verifyPackages({ cwd: directory });

    expect(report.canImport).toBe(false);
    expect(report.issues).toEqual([
        expect.objectContaining({
            code: PackageIssueCode.UnsupportedFeature,
            causeCode: "UnsupportedSymlink",
        }),
    ]);
    expect(report.methods.map((method) => method.name)).toEqual(["Readable"]);
});

test("conventional discovery does not follow imports.mf", async () => {
    const directory = await project({
        ".harness/packages/imports.mf":
            '<imports><package name="Missing" path="../absent" /></imports>',
        ".harness/packages/data.xml":
            '<Item type="Identity" action="add" id="PRESENT"><name>Present</name></Item>',
    });

    const report = await verifyPackages({ cwd: directory });

    expect(report.canImport).toBe(true);
    expect(report.documents).toHaveLength(1);
});

test("an explicitly supplied manifest reports its missing declared package", async () => {
    const directory = await project({
        ".harness/config.ts": 'export default { packages: ["../imports.mf"] };',
        "imports.mf":
            '<imports><package name="Example" path="Example"><dependson name="Required" /></package></imports>',
    });

    const report = await verifyPackages({ cwd: directory });

    expect(report.canImport).toBe(false);
    expect(report.issues[0]).toMatchObject({
        code: PackageIssueCode.MissingDependency,
        reference: { type: "PackageDefinition", name: "Required" },
        source: { file: join(directory, "imports.mf") },
    });
});

test("the extra path override retains automatic packages and deduplicates overlaps", async () => {
    const directory = await project({
        ".harness/config.ts": 'export default { packages: ["../not-selected"] };',
        ".harness/packages/Example/schema.xml": `<AML>${schema}</AML>`,
        "vendor/data.xml":
            '<Item type="VerificationRecord" action="add" id="RECORD"><name>Extra</name></Item>',
    });

    const report = await verifyPackages({
        cwd: directory,
        packages: ["./packages/Example", "../vendor"],
    });

    expect(report.canImport).toBe(true);
    expect(report.documents).toHaveLength(2);
    expect(report.issues).toEqual([]);
});

test("configuration failures become typed verification issues", async () => {
    const directory = await project({
        ".harness/config.ts": "export default { unsupported: true };",
    });

    const report = await verifyPackages({ cwd: directory });

    expect(report.canImport).toBe(false);
    expect(report.issues[0]?.code).toBe(PackageIssueCode.InvalidConfiguration);
    expect(report.issues[0]?.message).toContain("unsupported");
    expect(report.methods).toEqual([]);
});

test("successive verification calls reload packages and never retain previous probe records", async () => {
    const directory = await project({
        ".harness/packages/Example/data.xml": `<AML>${schema}
      <Item type="VerificationRecord" action="add" id="RECORD"><owner>OWNER</owner></Item>
    </AML>`,
    });
    const provider = join(directory, ".harness/packages/Provider/identity.xml");

    expect((await verifyPackages({ cwd: directory })).canImport).toBe(false);
    await Bun.write(
        provider,
        '<Item type="Identity" action="add" id="OWNER"><name>Owner</name></Item>',
    );
    expect((await verifyPackages({ cwd: directory })).canImport).toBe(true);
    await rm(provider);
    expect((await verifyPackages({ cwd: directory })).canImport).toBe(false);
});
