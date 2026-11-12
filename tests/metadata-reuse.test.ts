import { expect, spyOn, test } from "bun:test";

import { createEngine } from "../src/engine.js";
import { PackageImporter } from "../src/packages/importer.js";
import { importPackageDocuments } from "../src/packages/module.js";
import { parseAml } from "../src/packages/parser.js";
import { PlatformCatalog } from "../src/platform/catalog.js";
import { SqliteStorage } from "../src/storage/sqlite/storage.js";

test("Method source resolution selects its document without reading the full export", () => {
    const storage = new SqliteStorage();

    try {
        const xml = `<AML>
<Item type="Method" action="add" id="SOURCE_METHOD"><name>SourceMethod</name>
<method_type>C#</method_type><method_code><![CDATA[return this;]]></method_code>
</Item></AML>`;
        new PackageImporter(storage).import([parseAml(xml, "original.xml")]);
        const documents = spyOn(storage, "listDocuments");

        try {
            const catalog = new PlatformCatalog(storage);
            expect(catalog.method("SourceMethod").source).toMatchObject({
                file: "original.xml",
                line: 3,
                path: "/AML[1]/Item[1]/method_code[1]",
            });
            expect(documents).not.toHaveBeenCalled();

            storage.transactions.begin();
            new PackageImporter(storage).import([
                parseAml(
                    xml
                        .replace('action="add"', 'action="edit"')
                        .replace("return this;", "return null;"),
                    "original.xml",
                ),
            ]);
            expect(catalog.method("SourceMethod").code).toBe("return null;");
            storage.transactions.rollback();
            expect(catalog.method("SourceMethod").code).toBe("return this;");
        } finally {
            documents.mockRestore();
        }
    } finally {
        storage.close();
    }
});

test("cached catalog reads remain detached and reflect writes and rollback", () => {
    const storage = new SqliteStorage();

    try {
        const entry = {
            type: "Method",
            id: "OWNED",
            properties: { name: "Original" },
            attributes: { action: "add" },
            source: { file: "original.xml", line: 1, column: 1, path: "/AML/Item[1]" },
        };
        storage.putCatalogEntry(entry);
        const first = storage.getCatalogEntry("Method", "OWNED");
        expect(Reflect.set(first?.properties ?? {}, "name", "External")).toBe(true);
        expect(Reflect.set(first?.source ?? {}, "file", "external.xml")).toBe(true);
        expect(storage.getCatalogEntry("Method", "OWNED")).toEqual(entry);
        const listed = storage.listCatalogEntries("Method")[0];
        expect(Reflect.set(listed?.properties ?? {}, "name", "External list edit")).toBe(true);
        expect(storage.listCatalogEntries("Method")).toEqual([entry]);

        storage.transactions.begin();
        storage.putCatalogEntry({ ...entry, properties: { name: "Changed" } });
        expect(storage.listCatalogEntries("Method")[0]?.properties.name).toBe("Changed");
        storage.transactions.rollback();
        expect(storage.listCatalogEntries("Method")).toEqual([entry]);
        storage.deleteCatalogEntry("Method", "OWNED");
        expect(storage.listCatalogEntries("Method")).toEqual([]);
    } finally {
        storage.close();
    }
});

test("Method source positions follow changed XML bytes and roll back with their document", () => {
    const storage = new SqliteStorage();

    try {
        const xml = `<AML><Item type="Method" action="add" id="POSITION_METHOD">
<name>PositionMethod</name><method_type>C#</method_type>
<method_code>return this;</method_code></Item></AML>`;
        new PackageImporter(storage).import([parseAml(xml, "positions.xml")]);
        const catalog = new PlatformCatalog(storage);
        expect(catalog.method("PositionMethod").source.line).toBe(3);
        const original = storage.listDocuments()[0];

        if (!original) {
            throw new Error("The imported Method must retain its original XML document.");
        }

        storage.transactions.begin();
        storage.putDocument({
            ...original,
            xml: original.xml.replace("<method_code>", "\n\n<method_code>"),
        });
        expect(catalog.method("PositionMethod").source.line).toBe(5);
        storage.transactions.rollback();
        expect(catalog.method("PositionMethod").source.line).toBe(3);
    } finally {
        storage.close();
    }
});

test("Method-only imports reuse the schema and still reject missing references", () => {
    using engine = createEngine();
    const definitions = spyOn(engine.storage, "defineItemType");

    try {
        engine.runtime.executeSync(importPackageDocuments, [
            parseAml(
                `<AML>
            <Item type="Method" action="add" id="METHOD_ONLY"><name>MethodOnly</name>
            <method_type>C#</method_type><method_code>return this;</method_code></Item>
        </AML>`,
                "method-only.xml",
            ),
        ]);
        expect(definitions).not.toHaveBeenCalled();
        expect(engine.storage.getCatalogEntry("Method", "METHOD_ONLY")).toBeDefined();

        expect(() =>
            engine.runtime.executeSync(importPackageDocuments, [
                parseAml(
                    `<AML>
            <Item type="Method" action="edit" id="METHOD_ONLY">
            <execution_allowed_to>ABSENT_IDENTITY</execution_allowed_to></Item>
        </AML>`,
                    "missing-reference.xml",
                ),
            ]),
        ).toThrow("ABSENT_IDENTITY");
        expect(
            engine.storage.getCatalogEntry("Method", "METHOD_ONLY")?.properties,
        ).not.toHaveProperty("execution_allowed_to");

        engine.runtime.executeSync(importPackageDocuments, [
            parseAml(
                `<AML>
            <Item type="ItemType" action="add" id="NEW_SCHEMA"><name>NewSchema</name></Item>
        </AML>`,
                "new-schema.xml",
            ),
        ]);
        expect(definitions).toHaveBeenCalled();
        expect(engine.storage.getItemType("NewSchema")).toBeDefined();
    } finally {
        definitions.mockRestore();
    }
});
