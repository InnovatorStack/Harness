import { expect, test } from "bun:test";

import { createEngine } from "../src/engine.js";
import { Item } from "../src/items/item.js";
import { importPackageDocuments } from "../src/packages/module.js";
import { parseAml } from "../src/packages/parser.js";

function schema(implementation: string): string {
    return `<AML>
    <Item type="ItemType" action="add" id="EXTERNAL_TYPE">
      <name>ExternalRecord</name>
      <implementation_type>${implementation}</implementation_type>
      <Relationships>
        <Item type="Property" action="add" id="EXTERNAL_NAME">
          <name>name</name><data_type>string</data_type>
        </Item>
      </Relationships>
    </Item>
    <Item type="ItemType" action="add" id="LOCAL_TYPE">
      <name>LocalRecord</name>
      <Relationships>
        <Item type="Property" action="add">
          <name>external</name><data_type>item</data_type><data_source>EXTERNAL_TYPE</data_source>
        </Item>
      </Relationships>
    </Item>
  </AML>`;
}

test.each(["polymorphic", "federated"])(
    "%s definitions and unused references are retained without creating table storage",
    async (implementation) => {
        using engine = createEngine();
        const document = parseAml(schema(implementation), "external.xml");
        engine.runtime.executeSync(importPackageDocuments, [document]);

        expect(
            engine.storage.getCatalogEntry("ItemType", "EXTERNAL_TYPE")?.properties
                .implementation_type,
        ).toBe(implementation);
        expect(engine.storage.getCatalogEntry("Property", "EXTERNAL_NAME")?.properties.name).toBe(
            "name",
        );
        expect(engine.storage.getItemType("ExternalRecord")).toBeUndefined();
        expect(engine.storage.listDocuments()[0]?.xml).toBe(document.xml);
        await expect(engine.apply(Item.create("ExternalRecord", "get"))).rejects.toThrow(
            "requires an adapter",
        );
        engine.seed("LocalRecord", { external: null });
    },
);

test("importing records requiring unsupported storage fails atomically", () => {
    using engine = createEngine();
    const before = engine.storage.snapshot();
    expect(() =>
        engine.runtime.executeSync(importPackageDocuments, [
            parseAml(schema("polymorphic"), "external.xml"),
            parseAml(
                '<Item type="ExternalRecord" action="add" id="ROW"><name>Needs implementation</name></Item>',
                "data.xml",
            ),
        ]),
    ).toThrow("require an adapter");
    expect(engine.storage.snapshot()).toEqual(before);
});

test("populated references to unsupported storage fail rather than being treated as missing definitions", () => {
    using engine = createEngine();
    const before = engine.storage.snapshot();
    expect(() =>
        engine.runtime.executeSync(importPackageDocuments, [
            parseAml(schema("federated"), "external.xml"),
            parseAml(
                '<Item type="LocalRecord" action="add" id="ROW"><external>EXTERNAL_ID</external></Item>',
                "data.xml",
            ),
        ]),
    ).toThrow("Resolving its records requires an adapter");
    expect(engine.storage.snapshot()).toEqual(before);
});

test("unknown storage implementations remain explicit import failures", () => {
    using engine = createEngine();
    expect(() =>
        engine.runtime.executeSync(importPackageDocuments, [
            parseAml(schema("unknown"), "external.xml"),
        ]),
    ).toThrow("implementation 'unknown' requires an adapter");
});
