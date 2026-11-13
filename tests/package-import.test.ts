import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createRuntime, defineOperation } from "../src/core/index.js";
import type { Runtime } from "../src/core/index.js";
import { PackageImportError } from "../src/packages/diagnostics.js";
import { PackageImporter } from "../src/packages/importer.js";
import type { PackageLoadReport } from "../src/packages/importer.js";
import { parseAml } from "../src/packages/parser.js";
import type { AmlDocument } from "../src/packages/types.js";
import { SqliteStorage } from "../src/storage/sqlite/index.js";

const importOperation = defineOperation<readonly AmlDocument[], PackageLoadReport>("test.import");
const partSchema = `<Item type="ItemType" id="PART_TYPE" action="add">
  <name>FixturePart</name>
  <Relationships>
    <Item type="Property" id="LABEL_PROPERTY" action="add"><name>label</name><data_type>string</data_type></Item>
    <Item type="Property" id="COUNT_PROPERTY" action="add"><name>quantity</name><data_type>integer</data_type></Item>
    <Item type="Property" id="OPTIONAL_PROPERTY" action="add"><name>optional</name><data_type>string</data_type></Item>
    <Item type="Property" id="NEXT_PROPERTY" action="add"><name>next_part</name><data_type>item</data_type><data_source><Item type="ItemType" action="get" id="PART_TYPE" /></data_source></Item>
  </Relationships>
</Item>`;

let storage: SqliteStorage;
let runtime: Runtime;
let started = 0;
let startingCpu = { user: 0, system: 0 };
let startingRssBytes = 0;
let phases: { readonly name: string; readonly wallMs: number; readonly cpuMs: number }[] = [];

beforeEach(() => {
    phases = [];
    started = performance.now();
    startingCpu = process.cpuUsage();
    startingRssBytes = process.memoryUsage().rss;
    storage = timedPhase("open storage", () => new SqliteStorage());
    runtime = createRuntime({
        transactions: storage.transactions,
        modules: [
            {
                id: "test.packages",

                setup(registrar) {
                    registrar.handleSync(importOperation, (documents) => {
                        const importer = timedPhase(
                            "read import state",
                            () => new PackageImporter(storage),
                        );

                        return timedPhase("apply import", () => importer.import(documents));
                    });
                },
            },
        ],
    });
});

afterEach(() => {
    timedPhase("close runtime", () => runtime.close());
    timedPhase("close storage", () => storage.close());
    const wallMs = performance.now() - started;
    const slowTestMs = 1000;

    if (wallMs > slowTestMs) {
        const cpu = process.cpuUsage(startingCpu);
        console.warn("Slow importer test", {
            wallMs,
            cpuMs: (cpu.user + cpu.system) / 1000,
            startingRssBytes,
            memoryBytes: process.memoryUsage(),
            phases,
        });
    }
});

function timedPhase<Result>(name: string, run: () => Result): Result {
    const start = performance.now();
    const cpu = process.cpuUsage();

    try {
        return run();
    } finally {
        const used = process.cpuUsage(cpu);
        phases.push({
            name,
            wallMs: performance.now() - start,
            cpuMs: (used.user + used.system) / 1000,
        });
    }
}

function importXml(xml: string, file = "fixture.xml"): PackageLoadReport {
    return runtime.executeSync(importOperation, [parseAml(xml, file)]);
}

function expectImportFailure(action: () => unknown, code: string): PackageImportError {
    try {
        action();
    } catch (error) {
        expect(error).toBeInstanceOf(PackageImportError);

        if (!(error instanceof PackageImportError)) {
            throw error;
        }

        expect(error.code).toBe(code);

        return error;
    }

    throw new Error(`Expected package import to fail with ${code}.`);
}

describe("PackageImporter", () => {
    test("loads schema, forward references, exact method/SQL text, and lexical values", () => {
        const code = '  return "<&>";\r\n';
        const first = parseAml(
            `<AML>${partSchema}
      <Item type="FixturePart" action="add" id="ONE"><label></label><quantity>0</quantity><optional is_null="1" /><next_part><Item type="FixturePart" action="get"><label>Second</label></Item></next_part></Item>
      <Item type="Method" action="add" id="METHOD"><name>ActualMethodName</name><method_code><![CDATA[${code}]]></method_code><method_type>C#</method_type></Item>
      <Item type="SQL" action="add" id="SQL"><name>ActualSqlName</name><sqlserver_body><![CDATA[SELECT 'a&b';]]></sqlserver_body></Item>
    </AML>`,
            "first.xml",
        );
        const second = parseAml(
            '<AML><Item type="FixturePart" action="add" id="TWO"><label>Second</label></Item></AML>',
            "second.xml",
        );
        const report = runtime.executeSync(importOperation, [first, second]);
        expect(storage.getItem("FixturePart", "ONE")?.properties).toEqual({
            label: "",
            quantity: 0,
            optional: null,
            next_part: "TWO",
        });
        expect(storage.getItem("FixturePart", "TWO")?.properties).toEqual({
            label: "Second",
        });
        expect(storage.getCatalogEntry("Method", "METHOD")?.properties).toMatchObject({
            name: "ActualMethodName",
            method_code: code,
            method_type: "C#",
        });
        expect(storage.getCatalogEntry("SQL", "SQL")?.properties.sqlserver_body).toBe(
            "SELECT 'a&b';",
        );
        expect(report.documents).toEqual([
            { path: "first.xml", sha256: first.sha256 },
            { path: "second.xml", sha256: second.sha256 },
        ]);
        expect(storage.listDocuments().map((document) => document.xml)).toEqual([
            first.xml,
            second.xml,
        ]);
    });

    test("loads embedded relationship ItemTypes and relationship data with parent identity", () => {
        importXml(`<AML>${partSchema}
      <Item type="RelationshipType" id="LINK_TYPE" action="add"><name>FixtureLink</name><relationship_id><Item type="ItemType" id="LINK_ITEM_TYPE" action="add"><name>FixtureLink</name><is_relationship>1</is_relationship></Item></relationship_id></Item>
      <Item type="FixturePart" id="CHILD" action="add"><label>Child</label></Item>
      <Item type="FixturePart" id="PARENT" action="add"><label>Parent</label><Relationships><Item type="FixtureLink" action="add"><related_id><Item type="FixturePart" action="get" id="CHILD" /></related_id></Item></Relationships></Item>
    </AML>`);
        expect(storage.getItemType("FixtureLink")?.isRelationship).toBe(true);
        const relationships = storage.listItems("FixtureLink");
        expect(relationships).toHaveLength(1);
        expect(relationships[0]?.properties).toEqual({
            source_id: "PARENT",
            related_id: "CHILD",
        });
        expect(
            storage.getCatalogEntry("RelationshipType", "LINK_TYPE")?.properties.relationship_id,
        ).toBe("LINK_ITEM_TYPE");
    });

    test("applies ordered patches and deletes without replacing omitted values", () => {
        const report = importXml(`<AML>${partSchema}
      <Item type="FixturePart" id="KEEP" action="add"><label>Old</label><quantity>1</quantity></Item>
      <Item type="FixturePart" id="REMOVE" action="add"><label>Temporary</label></Item>
      <Item type="FixturePart" id="KEEP" action="edit"><label>New</label></Item>
      <Item type="FixturePart" id="REMOVE" action="delete" />
    </AML>`);
        expect(storage.getItem("FixturePart", "KEEP")?.properties).toEqual({
            label: "New",
            quantity: 1,
        });
        expect(storage.getItem("FixturePart", "REMOVE")).toBeUndefined();
        expect(storage.getCatalogEntry("FixturePart", "REMOVE")).toBeUndefined();
        expect(report.updated).toBe(1);
        expect(report.deleted).toBe(1);
    });

    test("relationship system properties can be patched by package selectors", () => {
        importXml(`<AML>
      <Item type="ItemType" id="LINK" action="add"><name>FixtureLink</name><is_relationship>1</is_relationship></Item>
      <Item type="ItemType" id="LINK" action="edit"><Relationships>
        <Item type="Property" action="edit" where="source_id='LINK' and name='sort_order'"><label>Sequence</label></Item>
      </Relationships></Item>
      <Item type="FixtureLink" id="ROW" action="add"><sort_order>128</sort_order></Item>
    </AML>`);
        expect(storage.getItem("FixtureLink", "ROW")?.properties.sort_order).toBe(128);
        const property = storage
            .listCatalogEntries("Property")
            .find(
                (entry) =>
                    entry.properties.source_id === "LINK" && entry.properties.name === "sort_order",
            );
        expect(property?.properties.label).toBe("Sequence");
    });

    test("references cannot resolve against catalog entries deleted from the live database", () => {
        importXml(
            `<AML>${partSchema}<Item type="FixturePart" id="DELETED" action="add"><label>Deleted</label></Item></AML>`,
        );
        storage.deleteItem("FixturePart", "DELETED");
        expectImportFailure(
            () =>
                importXml(
                    '<Item type="FixturePart" id="NEW" action="add"><next_part><Item type="FixturePart" id="DELETED" action="get" /></next_part></Item>',
                    "later.xml",
                ),
            "MISSING_REFERENCE",
        );
        expect(storage.getItem("FixturePart", "NEW")).toBeUndefined();
    });

    test("rolls back schema, data, catalog, and document writes on an unresolved reference", () => {
        const xml = `<AML>${partSchema}<Item type="FixturePart" id="BROKEN" action="add"><next_part>MISSING</next_part></Item></AML>`;
        const error = expectImportFailure(() => importXml(xml, "missing.xml"), "MISSING_REFERENCE");
        expect(error.source.file).toBe("missing.xml");
        expect(storage.listItemTypes()).toEqual([]);
        expect(storage.listCatalogEntries()).toEqual([]);
        expect(storage.listDocuments()).toEqual([]);
        expect(runtime.trace.at(-1)?.phase).toBe("failure");
    });

    test("keeps existing fixture state intact after a failed patch import", () => {
        importXml(
            `<AML>${partSchema}<Item type="FixturePart" id="ONE" action="add"><label>Original</label></Item></AML>`,
            "baseline.xml",
        );
        const snapshot = storage.snapshot();
        expectImportFailure(
            () =>
                importXml(
                    '<AML><Item type="FixturePart" id="ONE" action="edit"><label>Changed</label></Item><Item type="FixturePart" id="TWO" action="add"><next_part>MISSING</next_part></Item></AML>',
                    "broken-patch.xml",
                ),
            "MISSING_REFERENCE",
        );
        expect(storage.getItem("FixturePart", "ONE")?.properties.label).toBe("Original");
        expect(storage.getItem("FixturePart", "TWO")).toBeUndefined();
        expect(storage.snapshot()).toEqual(snapshot);
    });

    test("retains explicit system Property identity across later imports", () => {
        importXml(
            `<AML><Item type="ItemType" id="SYSTEM_TYPE" action="add"><name>FixtureSystem</name><Relationships><Item type="Property" id="00000000000000000000000000000000" action="add"><name>state</name><data_type>string</data_type></Item></Relationships></Item></AML>`,
        );
        const original = storage
            .getItemType("FixtureSystem")
            ?.properties.find((property) => property.name === "state");
        expect(original?.id).toBe("00000000000000000000000000000000");
        importXml(
            '<Item type="FixtureSystem" id="ONE" action="add"><state>Draft</state></Item>',
            "second-import.xml",
        );
        expect(
            storage
                .getItemType("FixtureSystem")
                ?.properties.find((property) => property.name === "state"),
        ).toEqual(original);
    });

    test("rejects unsupported selectors inside deferred get references", () => {
        expectImportFailure(
            () =>
                importXml(
                    `<AML>${partSchema}<Item type="FixturePart" action="add" id="ONE"><label>First</label><next_part><Item type="FixturePart" action="get" id="TWO" levels="2" /></next_part></Item><Item type="FixturePart" action="add" id="TWO"><label>Second</label></Item></AML>`,
                ),
            "UNSUPPORTED_SELECTOR",
        );
        expect(storage.listCatalogEntries()).toEqual([]);
    });

    test("rejects state-changing Item operations inside get predicates", () => {
        expectImportFailure(
            () =>
                importXml(
                    `<AML>${partSchema}<Item type="FixturePart" id="ONE" action="add"><label>Original</label><next_part>TARGET</next_part></Item><Item type="FixturePart" id="TARGET" action="add"><label>Existing target</label></Item><Item type="FixturePart" id="REF" action="add"><next_part><Item type="FixturePart" action="get" id="ONE"><next_part><Item type="FixturePart" action="add" id="INJECTED"><label>Side effect</label></Item></next_part></Item></next_part></Item></AML>`,
                ),
            "UNSUPPORTED_SELECTOR",
        );
        expect(storage.listCatalogEntries()).toEqual([]);
    });

    test("rejects unsupported relationship constraints instead of ignoring them in gets", () => {
        expectImportFailure(
            () =>
                importXml(
                    `<AML>${partSchema}<Item type="FixturePart" id="ONE" action="add"><label>Original</label><next_part><Item type="FixturePart" action="get" id="ONE"><Relationships><Item type="Member" action="get" id="MISSING" /></Relationships></Item></next_part></Item></AML>`,
                ),
            "UNSUPPORTED_SELECTOR",
        );
        expect(storage.listCatalogEntries()).toEqual([]);
    });

    test("rejects property constraints on delete instead of silently broadening its selector", () => {
        importXml(
            `<AML>${partSchema}<Item type="FixturePart" id="ONE" action="add"><label>Original</label></Item></AML>`,
            "baseline.xml",
        );
        expectImportFailure(
            () =>
                importXml(
                    '<Item type="FixturePart" id="ONE" action="delete"><label condition="eq">Different</label></Item>',
                    "delete.xml",
                ),
            "UNSUPPORTED_SELECTOR",
        );
        expect(storage.getItem("FixturePart", "ONE")?.properties.label).toBe("Original");
    });

    test("matches mixed-case ItemType names and IDs consistently with SQLite", () => {
        importXml(
            `<AML>${partSchema}<Item type="FixturePart" id="ONE" action="add"><label>Original</label><next_part type="fixturepart">two</next_part></Item><Item type="FixturePart" id="TWO" action="add"><label>Target</label></Item></AML>`,
            "baseline.xml",
        );
        importXml(
            '<Item type="fixturepart" id="one" action="edit"><label>Updated</label><next_part><Item type="FIXTUREPART" action="get" id="two" /></next_part></Item>',
            "patch.xml",
        );
        expect(storage.getItem("FixturePart", "ONE")?.properties).toEqual({
            label: "Updated",
            next_part: "TWO",
        });
        expect(storage.listItems("FixturePart")).toHaveLength(2);
    });

    test("patches current stored state rather than reverting prior runtime mutations", () => {
        importXml(
            `<AML>${partSchema}<Item type="FixturePart" id="ONE" action="add"><label>Original</label><quantity>1</quantity></Item></AML>`,
            "baseline.xml",
        );
        storage.updateItem("FixturePart", "ONE", {
            label: "Changed by runtime",
            optional: "Runtime value",
        });
        importXml(
            '<Item type="FixturePart" id="ONE" action="edit"><quantity>2</quantity></Item>',
            "patch.xml",
        );
        expect(storage.getItem("FixturePart", "ONE")?.properties).toEqual({
            label: "Changed by runtime",
            optional: "Runtime value",
            quantity: 2,
        });
        expect(storage.getCatalogEntry("FixturePart", "ONE")?.properties).toEqual({
            label: "Changed by runtime",
            optional: "Runtime value",
            quantity: 2,
        });
    });

    test("matches typed numeric predicates identically before and after persistence", () => {
        importXml(
            `<AML>${partSchema}<Item type="FixturePart" id="ONE" action="add"><label>Original</label><quantity>1</quantity><is_current>0</is_current></Item></AML>`,
            "baseline.xml",
        );
        importXml(
            '<Item type="FixturePart" id="TWO" action="add"><next_part><Item type="FixturePart" action="get"><quantity>1</quantity><is_current>0</is_current></Item></next_part></Item>',
            "numeric-reference.xml",
        );
        expect(storage.getItem("FixturePart", "TWO")?.properties.next_part).toBe("ONE");
    });
});

test("native platform ItemTypes replace stand-ins while retaining exported IDs and references", () => {
    importXml("<AML />", "bootstrap.xml");
    const oldId = storage.getItemType("User")?.id;
    importXml(
        `<AML>
    <Item type="ItemType" action="add" id="NATIVE_USER"><name>User</name><instance_data>USER</instance_data></Item>
    <Item type="ItemType" action="add" id="NATIVE_IDENTITY"><name>Identity</name><instance_data>IDENTITY</instance_data></Item>
    <Item type="ItemType" action="add" id="ASSIGNMENT"><name>Assignment</name>
      <Relationships><Item type="Property" action="add" id="ASSIGNEE"><name>assignee</name><data_type>item</data_type><data_source type="ItemType">NATIVE_USER</data_source></Item></Relationships>
    </Item>
    <Item type="User" action="add" id="PERSON"><login_name>developer</login_name></Item>
    <Item type="Assignment" action="add" id="TASK"><assignee type="User">PERSON</assignee></Item>
  </AML>`,
        "native.xml",
    );
    expect(storage.getItemType("User")?.id).toBe("NATIVE_USER");
    expect(storage.getItemType("Identity")?.id).toBe("NATIVE_IDENTITY");
    expect(
        storage
            .getItemType("Assignment")
            ?.properties.find((property) => property.name === "assignee")?.dataSource,
    ).toBe("NATIVE_USER");
    expect(storage.getItem("Assignment", "TASK")?.properties.assignee).toBe("PERSON");
    expect(
        storage.listCatalogEntries("ItemType").filter((entry) => entry.properties.name === "User"),
    ).toHaveLength(1);
    expect(storage.getCatalogEntry("ItemType", oldId ?? "")).toBeUndefined();
    importXml('<Item type="Identity" action="add" id="TEAM"><name>Team</name></Item>', "later.xml");
    expect(storage.getItemType("User")?.id).toBe("NATIVE_USER");
});

test("current generation fixtures retain native config_id metadata without requiring history rows", () => {
    importXml(`<AML>${partSchema}
    <Item type="ItemType" id="PART_TYPE" action="edit"><Relationships>
      <Item type="Property" action="edit" where="source_id='PART_TYPE' and name='config_id'"><data_source type="ItemType">PART_TYPE</data_source></Item>
    </Relationships></Item>
    <Item type="FixturePart" action="add" id="CURRENT"><config_id type="FixturePart">HISTORICAL_FIRST</config_id><generation>8</generation><is_current>1</is_current><label>Current</label></Item>
  </AML>`);
    expect(storage.getItem("FixturePart", "CURRENT")?.properties.config_id).toBe(
        "HISTORICAL_FIRST",
    );
    expect(
        storage
            .getItemType("FixturePart")
            ?.properties.find((property) => property.name === "config_id")?.dataSource,
    ).toBe("PART_TYPE");
    expect(storage.getItem("FixturePart", "HISTORICAL_FIRST")).toBeUndefined();
});

test("missing dependency references are reported together and leave the database unchanged", () => {
    importXml("<AML />");
    const before = storage.snapshot();
    let failure: unknown;

    try {
        importXml(
            `<AML>
      <Item type="Method" action="add" id="ONE"><name>One</name><execution_allowed_to type="Identity">MISSING_ONE</execution_allowed_to></Item>
      <Item type="Method" action="add" id="TWO"><name>Two</name><execution_allowed_to type="Identity">MISSING_TWO</execution_allowed_to></Item>
    </AML>`,
            "dependencies.xml",
        );
    } catch (error) {
        failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);

    if (!(failure instanceof AggregateError)) {
        throw new TypeError("Expected aggregated dependency errors.");
    }

    expect(failure.errors).toHaveLength(2);
    expect(
        failure.errors.map((error: unknown) =>
            error instanceof PackageImportError ? error.source.file : undefined,
        ),
    ).toEqual(["dependencies.xml", "dependencies.xml"]);
    expect(storage.snapshot()).toEqual(before);
});

test("presentation definitions retain source and native references without executing UI dependencies", () => {
    const xml = `<Item type="CommandBarSection" action="add" id="SECTION"><name>Tools</name><location type="cui_Location">REMOTE_LOCATION</location></Item>`;
    importXml(xml, "presentation.xml");
    expect(storage.getCatalogEntry("CommandBarSection", "SECTION")?.properties.location).toBe(
        "REMOTE_LOCATION",
    );
    expect(
        storage.listDocuments().find((document) => document.path === "presentation.xml")?.xml,
    ).toBe(xml);
});

test("stored event bindings can reference imported presentation records", () => {
    importXml(`<AML>
        <Item type="ItemType" action="add" id="FIELD_EVENT_TYPE">
            <name>Field Event</name><is_relationship>1</is_relationship>
            <Relationships>
                <Item type="Property" action="add">
                    <name>source_id</name><data_type>item</data_type>
                    <data_source><Item type="ItemType" action="get"><name>Field</name></Item></data_source>
                </Item>
            </Relationships>
        </Item>
        <Item type="Field" action="add" id="IMPORTED_FIELD"><name>Example</name></Item>
        <Item type="Field Event" action="add" id="IMPORTED_FIELD_EVENT">
            <source_id type="Field">IMPORTED_FIELD</source_id>
        </Item>
    </AML>`);

    expect(storage.getItem("Field Event", "IMPORTED_FIELD_EVENT")?.properties.source_id).toBe(
        "IMPORTED_FIELD",
    );
});
