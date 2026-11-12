import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEngine } from "../src/engine.js";
import type { Engine } from "../src/engine.js";
import { PackageImportError } from "../src/packages/diagnostics.js";
import { importPackageDocuments } from "../src/packages/module.js";
import { parseAml } from "../src/packages/parser.js";

let directory: string;

beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "harness-import-plan-"));
});

afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
});

async function exported(path: string, items: string): Promise<string> {
    const file = join(directory, path);
    await Bun.write(file, `<AML>\n${items}\n</AML>`);

    return file;
}

function initial(engine: Engine, items: string): void {
    engine.runtime.executeSync(importPackageDocuments, [
        parseAml(`<AML>${items}</AML>`, "initial.xml"),
    ]);
}

async function failures(engine: Engine): Promise<readonly PackageImportError[]> {
    try {
        await engine.loadPackages([directory]);
    } catch (error) {
        const errors: unknown[] = error instanceof AggregateError ? error.errors : [error];

        return errors.map((issue) => {
            expect(issue).toBeInstanceOf(PackageImportError);

            if (!(issue instanceof PackageImportError)) {
                throw issue;
            }

            return issue;
        });
    }

    throw new Error("Expected the import to fail.");
}

const schema = `<Item type="ItemType" action="add" id="PLANNED_TYPE">
  <name>PlannedRecord</name><is_versionable>0</is_versionable>
  <Relationships><Item type="Property" action="add" id="PLANNED_LABEL"><name>label</name><data_type>string</data_type></Item></Relationships>
</Item>`;

const identity =
    '<Item type="Identity" action="add" id="TARGET"><name>Before</name><description>Original</description></Item>';

test.each(["A-patch/Z-base", "Z-patch/A-base"])(
    "cross-folder schema dependencies survive filename order: %s",
    async (layout) => {
        const [patch, base] = layout.split("/");
        await exported(
            `${patch}/Import/patch.xml`,
            '<Item type="ItemType" action="edit" id="PLANNED_TYPE"><is_versionable>1</is_versionable></Item>',
        );
        await exported(`${base}/Import/schema.xml`, schema);
        using engine = createEngine();

        const report = await engine.loadPackages([directory]);

        expect(engine.storage.getItemType("PlannedRecord")?.isVersionable).toBe(true);
        expect(
            engine.storage
                .getItemType("PlannedRecord")
                ?.properties.find((property) => property.name === "label")?.id,
        ).toBe("PLANNED_LABEL");
        expect(report.updated).toBe(1);
    },
);

test("actions from different files interleave without changing either file's sequence", async () => {
    await exported(
        "A/Import/sequence.xml",
        `
    <Item type="Identity" action="edit" id="Y"><description>Y patched</description></Item>
    <Item type="Identity" action="add" id="X"><name>X</name></Item>
  `,
    );
    await exported(
        "B/Import/sequence.xml",
        `
    <Item type="Identity" action="add" id="Y"><name>Y</name></Item>
    <Item type="Identity" action="edit" id="X"><description>X patched</description></Item>
  `,
    );
    using engine = createEngine();

    const report = await engine.loadPackages([directory]);

    expect(engine.storage.getItem("Identity", "X")?.properties.description).toBe("X patched");
    expect(engine.storage.getItem("Identity", "Y")?.properties.description).toBe("Y patched");
    expect(report.added).toBe(2);
    expect(report.updated).toBe(2);
});

test("blocked nested actions restore their partial parent mutations before retrying", async () => {
    using engine = createEngine();
    initial(engine, identity);
    await exported(
        "A/parent.xml",
        `
    <Item type="Identity" action="edit" id="TARGET">
      <description>Updated</description>
      <Relationships><Item type="Member" action="edit" id="MEMBER"><description>Nested update</description></Item></Relationships>
    </Item>
  `,
    );
    await exported(
        "Z/member.xml",
        `
    <Item type="Member" action="add" id="MEMBER"><source_id type="Identity">TARGET</source_id><related_id type="Identity">TARGET</related_id></Item>
  `,
    );

    const report = await engine.loadPackages([directory]);

    expect(engine.storage.getItem("Identity", "TARGET")?.properties.description).toBe("Updated");
    expect(engine.storage.getItem("Member", "MEMBER")?.properties.description).toBe(
        "Nested update",
    );
    expect(report.added).toBe(1);
    expect(report.updated).toBe(2);
});

test.each(["A-read/Z-edit", "Z-read/A-edit"])(
    "selector preconditions determine ordering without relying on filenames: %s",
    async (layout) => {
        using engine = createEngine();
        initial(engine, identity);
        const [read, edit] = layout.split("/");
        await exported(
            `${read}/get.xml`,
            '<Item type="Identity" action="get"><name>Before</name></Item>',
        );
        await exported(
            `${edit}/edit.xml`,
            '<Item type="Identity" action="edit" id="TARGET"><name>After</name></Item>',
        );

        await engine.loadPackages([directory]);

        expect(engine.storage.getItem("Identity", "TARGET")?.properties.name).toBe("After");
    },
);

test("a selector can depend on another file's edit", async () => {
    using engine = createEngine();
    initial(engine, identity);
    await exported(
        "A/patch.xml",
        '<Item type="Identity" action="edit" where="name=\'After\'"><description>Patched by selector</description></Item>',
    );
    await exported(
        "Z/rename.xml",
        '<Item type="Identity" action="edit" id="TARGET"><name>After</name></Item>',
    );

    await engine.loadPackages([directory]);

    expect(engine.storage.getItem("Identity", "TARGET")?.properties).toMatchObject({
        name: "After",
        description: "Patched by selector",
    });
});

test("a forward dependency cannot reverse actions in the same XML file", async () => {
    using engine = createEngine();
    const before = engine.storage.snapshot();
    const file = await exported(
        "sequence.xml",
        `
    <Item type="Identity" action="edit" id="LATER"><description>Must not run after its later add</description></Item>
    <Item type="Identity" action="add" id="LATER"><name>Later</name></Item>
  `,
    );

    const errors = await failures(engine);

    expect(
        errors.some((error) => error.code === "CYCLIC_IMPORT_ORDER" && error.source.file === file),
    ).toBe(true);
    expect(engine.storage.snapshot()).toEqual(before);
});

test("cycles across files report their sources and leave no imported state", async () => {
    using engine = createEngine();
    const before = engine.storage.snapshot();
    const first = await exported(
        "A/sequence.xml",
        `
    <Item type="Identity" action="edit" id="Y"><description>Y</description></Item>
    <Item type="Identity" action="add" id="X"><name>X</name></Item>
  `,
    );
    const second = await exported(
        "B/sequence.xml",
        `
    <Item type="Identity" action="edit" id="X"><description>X</description></Item>
    <Item type="Identity" action="add" id="Y"><name>Y</name></Item>
  `,
    );

    const errors = await failures(engine);
    const cycle = errors.find((error) => error.code === "CYCLIC_IMPORT_ORDER");

    expect(cycle).toBeDefined();
    expect(
        new Set([
            cycle?.source.file,
            ...(cycle?.relatedSources.map((source) => source.file) ?? []),
        ]),
    ).toEqual(new Set([first, second]));
    expect(engine.storage.snapshot()).toEqual(before);
});

test("missing action targets in separate folders are reported together", async () => {
    using engine = createEngine();
    const first = await exported(
        "A/missing.xml",
        '<Item type="Identity" action="edit" id="MISSING_A"><name>A</name></Item>',
    );
    const second = await exported(
        "B/missing.xml",
        '<Item type="Identity" action="get" id="MISSING_B" />',
    );

    const errors = await failures(engine);

    expect(
        errors
            .filter((error) => error.code === "MISSING_REFERENCE")
            .map((error) => error.source.file)
            .sort(),
    ).toEqual([first, second]);
});

test("conflicting additions and independent missing references share one diagnostic report", async () => {
    using engine = createEngine();
    const before = engine.storage.snapshot();
    const first = await exported(
        "A/identity.xml",
        '<Item type="Identity" action="add" id="DUPLICATE"><name>First</name></Item>',
    );
    const second = await exported(
        "B/identity.xml",
        '<Item type="Identity" action="add" id="DUPLICATE"><name>Second</name></Item>',
    );
    const missing = await exported(
        "C/method.xml",
        '<Item type="Method" action="add" id="METHOD"><name>NeedsIdentity</name><execution_allowed_to type="Identity">MISSING</execution_allowed_to></Item>',
    );

    const errors = await failures(engine);
    const duplicate = errors.find((error) => error.code === "DUPLICATE_ITEM");

    expect(duplicate?.source.file).toBe(second);
    expect(duplicate?.relatedSources.map((source) => source.file)).toContain(first);
    expect(
        errors.some((error) => error.code === "MISSING_REFERENCE" && error.source.file === missing),
    ).toBe(true);
    expect(engine.storage.snapshot()).toEqual(before);
});

test.each(["Original", "First patch"])(
    "unordered writes to the same field reject ambiguity, including a no-op write: %s",
    async (value) => {
        using engine = createEngine();
        initial(engine, identity);
        const before = engine.storage.snapshot();
        const first = await exported(
            "A/edit.xml",
            `<Item type="Identity" action="edit" id="TARGET"><description>${value}</description></Item>`,
        );
        const second = await exported(
            "B/edit.xml",
            '<Item type="Identity" action="edit" id="TARGET"><description>Second patch</description></Item>',
        );

        const errors = await failures(engine);
        const conflict = errors.find((error) => error.code === "AMBIGUOUS_IMPORT_ORDER");

        expect(conflict?.message).toContain("description");
        expect(
            new Set([
                conflict?.source.file,
                ...(conflict?.relatedSources.map((source) => source.file) ?? []),
            ]),
        ).toEqual(new Set([first, second]));
        expect(engine.storage.snapshot()).toEqual(before);
    },
);

test("independent patches to different fields can be imported together", async () => {
    using engine = createEngine();
    initial(engine, identity);
    await exported(
        "A/name.xml",
        '<Item type="Identity" action="edit" id="TARGET"><name>Renamed</name></Item>',
    );
    await exported(
        "B/description.xml",
        '<Item type="Identity" action="edit" id="TARGET"><description>Updated</description></Item>',
    );

    await engine.loadPackages([directory]);

    expect(engine.storage.getItem("Identity", "TARGET")?.properties).toMatchObject({
        name: "Renamed",
        description: "Updated",
    });
});

test.each(["A-add/B-read/C-add", "B-add/A-read/C-add"])(
    "selectors with competing providers cannot choose a target from filenames: %s",
    async (layout) => {
        using engine = createEngine();
        const [first, read, second] = layout.split("/");
        await exported(
            `${first}/data.xml`,
            '<Item type="Identity" action="add" id="FIRST"><name>Shared</name></Item>',
        );
        await exported(
            `${second}/data.xml`,
            '<Item type="Identity" action="add" id="SECOND"><name>Shared</name></Item>',
        );
        await exported(
            `${read}/get.xml`,
            '<Item type="Identity" action="get"><name>Shared</name></Item>',
        );

        const errors = await failures(engine);

        expect(errors.some((error) => error.code === "AMBIGUOUS_REFERENCE")).toBe(true);
    },
);

test.each(["A-delete/Z-add", "Z-delete/A-add"])(
    "an optional delete cannot silently change meaning across files: %s",
    async (layout) => {
        using engine = createEngine();
        const [deleted, added] = layout.split("/");
        await exported(
            `${deleted}/delete.xml`,
            '<Item type="Identity" action="delete" id="TARGET" />',
        );
        await exported(`${added}/add.xml`, identity);

        const errors = await failures(engine);

        expect(errors.some((error) => error.code === "AMBIGUOUS_IMPORT_ORDER")).toBe(true);
    },
);

test("an existing record can be replaced when deletion is required before its addition", async () => {
    using engine = createEngine();
    initial(engine, identity);
    await exported(
        "A/add.xml",
        '<Item type="Identity" action="add" id="TARGET"><name>Replacement</name></Item>',
    );
    await exported("Z/delete.xml", '<Item type="Identity" action="delete" id="TARGET" />');

    await engine.loadPackages([directory]);

    const replaced = engine.storage.getItem("Identity", "TARGET");
    expect(replaced?.properties.name).toBe("Replacement");
    expect(replaced?.properties).not.toHaveProperty("description");
});

test("ordered patches, deletion and recreation retain their XML sequence", async () => {
    using engine = createEngine();
    await exported(
        "sequence.xml",
        `
    ${identity}
    <Item type="Identity" action="edit" id="TARGET"><description>First patch</description></Item>
    <Item type="Identity" action="edit" id="TARGET"><description>Last patch</description></Item>
    <Item type="Identity" action="delete" id="TARGET" />
    <Item type="Identity" action="add" id="TARGET"><name>Recreated</name></Item>
  `,
    );

    const report = await engine.loadPackages([directory]);

    const recreated = engine.storage.getItem("Identity", "TARGET");
    expect(recreated?.properties.name).toBe("Recreated");
    expect(recreated?.properties).not.toHaveProperty("description");
    expect(report.added).toBe(2);
    expect(report.updated).toBe(2);
    expect(report.deleted).toBe(1);
});

test("conflicting schema names and property declarations are reported together", async () => {
    using engine = createEngine();
    const before = engine.storage.snapshot();
    const first = await exported("A/schema.xml", schema);
    const duplicateType = await exported(
        "B/schema.xml",
        '<Item type="ItemType" action="add" id="OTHER_TYPE"><name>PlannedRecord</name></Item>',
    );
    const duplicateProperty = await exported(
        "C/property.xml",
        '<Item type="Property" action="add" id="OTHER_LABEL"><source_id>PLANNED_TYPE</source_id><name>label</name><data_type>string</data_type></Item>',
    );

    const errors = await failures(engine);

    expect(errors.find((error) => error.code === "DUPLICATE_ITEM_TYPE")?.source.file).toBe(
        duplicateType,
    );
    expect(errors.find((error) => error.code === "DUPLICATE_PROPERTY")?.source.file).toBe(
        duplicateProperty,
    );
    expect(
        errors.every((error) => error.relatedSources.some((source) => source.file === first)),
    ).toBe(true);
    expect(engine.storage.snapshot()).toEqual(before);
});

test("untyped item references are validated together and roll back schema and records", async () => {
    using engine = createEngine();
    const before = engine.storage.snapshot();
    await exported(
        "A/schema.xml",
        `<Item type="ItemType" action="add" id="REFERENCE_TYPE"><name>ReferenceRecord</name>
    <Relationships><Item type="Property" action="add" id="NEXT_REFERENCE"><name>next_record</name><data_type>item</data_type><data_source>REFERENCE_TYPE</data_source></Item></Relationships>
  </Item>`,
    );
    const first = await exported(
        "B/data.xml",
        '<Item type="ReferenceRecord" action="add" id="FIRST"><next_record>MISSING_FIRST</next_record></Item>',
    );
    const second = await exported(
        "C/data.xml",
        '<Item type="ReferenceRecord" action="add" id="SECOND"><next_record>MISSING_SECOND</next_record></Item>',
    );

    const errors = await failures(engine);

    expect(
        errors
            .filter((error) => error.code === "MISSING_REFERENCE")
            .map((error) => error.source.file)
            .sort(),
    ).toEqual([first, second]);
    expect(engine.storage.snapshot()).toEqual(before);
});

test("selectors compare reference IDs without requiring a later target to be created early", async () => {
    using engine = createEngine();
    initial(engine, identity);
    await exported(
        "A/patch.xml",
        '<Item type="Member" action="edit" where="related_id=\'FUTURE\'"><description>Linked</description></Item>',
    );
    await exported(
        "B/member.xml",
        '<Item type="Member" action="add" id="MEMBER"><source_id type="Identity">TARGET</source_id><related_id type="Identity">FUTURE</related_id></Item>',
    );
    await exported(
        "Z/identity.xml",
        `
    <Item type="Member" action="get" id="MEMBER"><description>Linked</description></Item>
    <Item type="Identity" action="add" id="FUTURE"><name>Future target</name></Item>
  `,
    );

    await engine.loadPackages([directory]);

    expect(engine.storage.getItem("Member", "MEMBER")?.properties.description).toBe("Linked");
    expect(engine.storage.getItem("Identity", "FUTURE")?.properties.name).toBe("Future target");
});

test("existing baseline records are available to selectors before solution additions", async () => {
    using engine = createEngine();
    initial(engine, identity);
    await exported(
        "solution/Import/records.xml",
        `
    <Item type="Identity" action="get" id="TARGET" />
    <Item type="Member" action="add" id="MEMBER"><source_id type="Identity">TARGET</source_id><related_id type="Identity">TARGET</related_id></Item>
  `,
    );

    await engine.loadPackages([directory]);

    expect(engine.storage.getItem("Member", "MEMBER")?.properties.related_id).toBe("TARGET");
});

test("planning retains original XML and exact Method and SQL source without executing them", async () => {
    using engine = createEngine();
    initial(engine, identity);
    const methodCode = "// Original source\r\nreturn this;\r\n";
    const sql = "SELECT '<&>' AS value;\r\n";
    await exported(
        "A/patch.xml",
        '<Item type="Method" action="edit" id="ORIGINAL_METHOD"><execution_allowed_to type="Identity">TARGET</execution_allowed_to></Item>',
    );
    const sourceFile = await exported(
        "Z/source.xml",
        `
    <Item type="Method" action="add" id="ORIGINAL_METHOD"><name>OriginalMethod</name><method_type>C#</method_type><method_code><![CDATA[${methodCode}]]></method_code></Item>
    <Item type="SQL" action="add" id="ORIGINAL_SQL"><name>OriginalSql</name><sqlserver_body><![CDATA[${sql}]]></sqlserver_body></Item>
  `,
    );
    const original = await Bun.file(sourceFile).text();

    const report = await engine.loadPackages([directory]);

    expect(
        engine.storage.getCatalogEntry("Method", "ORIGINAL_METHOD")?.properties.method_code,
    ).toBe(methodCode);
    expect(engine.storage.getCatalogEntry("SQL", "ORIGINAL_SQL")?.properties.sqlserver_body).toBe(
        sql,
    );
    expect(
        engine.storage.listDocuments().find((document) => document.path === sourceFile)?.xml,
    ).toBe(original);
    expect(report.documents.find((document) => document.path === sourceFile)?.sha256).toBe(
        new Bun.CryptoHasher("sha256").update(original).digest("hex"),
    );
    expect(engine.trace.filter((event) => event.kind === "method")).toEqual([]);
});
