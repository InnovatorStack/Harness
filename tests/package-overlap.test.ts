import { expect, test } from "bun:test";

import { createEngine } from "../src/engine.js";
import { importPackageDocuments } from "../src/packages/module.js";
import { parseAml } from "../src/packages/parser.js";

const schema = `<Item type="ItemType" id="RECORD_TYPE" action="add">
  <name>TestRecord</name>
  <Relationships>
    <Item type="Property" action="add"><name>name</name><data_type>string</data_type></Item>
    <Item type="Property" action="add"><name>description</name><data_type>string</data_type></Item>
    <Item type="Property" action="add">
      <name>parent</name><data_type>item</data_type><data_source>RECORD_TYPE</data_source>
    </Item>
  </Relationships>
</Item>`;

test.each([false, true])(
    "compatible additions across files merge their declared fields: reversed=%s",
    (reversed) => {
        using engine = createEngine();
        const documents = [
            parseAml(
                '<Item type="TestRecord" id="ONE" action="add"><name>Record</name></Item>',
                "name.xml",
            ),
            parseAml(
                '<Item type="TestRecord" id="ONE" action="add"><description>Description</description></Item>',
                "description.xml",
            ),
        ];

        if (reversed) {
            documents.reverse();
        }

        const report = engine.runtime.executeSync(importPackageDocuments, [
            parseAml(schema, "schema.xml"),
            ...documents,
        ]);

        expect(engine.storage.listItems("TestRecord")).toEqual([
            {
                id: "ONE",
                type: "TestRecord",
                properties: { name: "Record", description: "Description" },
            },
        ]);
        expect(report.added).toBe(5);

        for (const document of documents) {
            expect(engine.storage.listDocuments().map((stored) => stored.xml)).toContain(
                document.xml,
            );
        }
    },
);

test("an inline record and its standalone export share one stored identity", () => {
    using engine = createEngine();
    const embedded = parseAml(
        `<Item type="TestRecord" id="CHILD" action="add">
    <name>Child</name>
    <parent><Item type="TestRecord" id="PARENT" action="add"><name>Parent</name></Item></parent>
  </Item>`,
        "embedded.xml",
    );
    const standalone = parseAml(
        '<Item type="TestRecord" id="PARENT" action="add"><name>Parent</name><description>Expanded export</description></Item>',
        "standalone.xml",
    );
    engine.runtime.executeSync(importPackageDocuments, [
        parseAml(schema, "schema.xml"),
        embedded,
        standalone,
    ]);

    expect(engine.storage.listItems("TestRecord")).toHaveLength(2);
    expect(engine.storage.getItem("TestRecord", "CHILD")?.properties.parent).toBe("PARENT");
    expect(engine.storage.getItem("TestRecord", "PARENT")?.properties).toEqual({
        name: "Parent",
        description: "Expanded export",
    });
});

test("conflicting repeated additions report both original sources and roll back", () => {
    using engine = createEngine();
    const before = engine.storage.snapshot();
    expect(() =>
        engine.runtime.executeSync(importPackageDocuments, [
            parseAml(schema, "schema.xml"),
            parseAml(
                '<Item type="TestRecord" id="ONE" action="add"><name>First</name></Item>',
                "first.xml",
            ),
            parseAml(
                '<Item type="TestRecord" id="ONE" action="add"><name>Second</name></Item>',
                "second.xml",
            ),
        ]),
    ).toThrow("Other declaration: first.xml");
    expect(engine.storage.snapshot()).toEqual(before);
});

test("repeated additions within one XML sequence still fail", () => {
    using engine = createEngine();
    expect(() =>
        engine.runtime.executeSync(importPackageDocuments, [
            parseAml(
                `<AML>${schema}
      <Item type="TestRecord" id="ONE" action="add"><name>Same</name></Item>
      <Item type="TestRecord" id="ONE" action="add"><name>Same</name></Item>
    </AML>`,
                "sequence.xml",
            ),
        ]),
    ).toThrow("already exists");
});

test("an existing imported record cannot be overwritten by a later import's additions", () => {
    using engine = createEngine();
    const original = parseAml(
        `<AML>${schema}
    <Item type="TestRecord" id="ONE" action="add"><name>Original</name></Item>
  </AML>`,
        "original.xml",
    );
    engine.runtime.executeSync(importPackageDocuments, [original]);
    expect(() =>
        engine.runtime.executeSync(importPackageDocuments, [
            parseAml(
                '<Item type="TestRecord" id="ONE" action="add"><name>Original</name></Item>',
                "first.xml",
            ),
            parseAml(
                '<Item type="TestRecord" id="ONE" action="add"><name>Original</name></Item>',
                "second.xml",
            ),
        ]),
    ).toThrow("already exists");
    expect(engine.storage.getItem("TestRecord", "ONE")?.properties.name).toBe("Original");
});

test("versionable ItemTypes expose generated date Properties before exported edits", () => {
    using engine = createEngine();
    engine.runtime.executeSync(importPackageDocuments, [
        parseAml(
            `<AML>
      <Item type="ItemType" id="VERSIONED" action="add"><name>TestVersioned</name><is_versionable>1</is_versionable></Item>
      <Item type="Property" action="edit" where="source_id='VERSIONED' and name='superseded_date'"><label>Historical end</label></Item>
    </AML>`,
            "versionable.xml",
        ),
    ]);
    const properties = engine.storage.getItemType("TestVersioned")?.properties;
    expect(
        properties
            ?.filter((property) =>
                ["effective_date", "release_date", "superseded_date"].includes(property.name),
            )
            .map((property) => property.dataType),
    ).toEqual(["date", "date", "date"]);
    expect(
        engine.storage
            .listItems("Property")
            .find(
                (property) =>
                    property.properties.source_id === "VERSIONED" &&
                    property.properties.name === "superseded_date",
            )?.properties.label,
    ).toBe("Historical end");
});
