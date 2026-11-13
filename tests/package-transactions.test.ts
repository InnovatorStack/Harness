import { expect, test } from "bun:test";

import { createEngine } from "../src/engine.js";
import { PackageImportError } from "../src/packages/diagnostics.js";
import { PackageImporter } from "../src/packages/importer.js";
import { importPackageDocuments } from "../src/packages/module.js";
import { parseAml } from "../src/packages/parser.js";
import { SqliteStorage } from "../src/storage/sqlite/index.js";
import type { HarnessStorage } from "../src/storage/types.js";

const schema = `<Item type="ItemType" action="add" id="ATOMIC_TYPE">
    <name>AtomicPart</name>
    <Relationships>
        <Item type="Property" action="add" id="ATOMIC_LABEL">
            <name>label</name><data_type>string</data_type>
        </Item>
        <Item type="Property" action="add" id="ATOMIC_NEXT">
            <name>next_part</name><data_type>item</data_type>
            <data_source type="ItemType">ATOMIC_TYPE</data_source>
        </Item>
    </Relationships>
</Item>`;

function portable(storage: SqliteStorage): HarnessStorage {
    return {
        transactions: storage.transactions,
        defineItemType: storage.defineItemType.bind(storage),
        getItemType: storage.getItemType.bind(storage),
        listItemTypes: storage.listItemTypes.bind(storage),
        insertItem: storage.insertItem.bind(storage),
        updateItem: storage.updateItem.bind(storage),
        getItem: storage.getItem.bind(storage),
        listItems: storage.listItems.bind(storage),
        deleteItem: storage.deleteItem.bind(storage),
        putCatalogEntry: storage.putCatalogEntry.bind(storage),
        getCatalogEntry: storage.getCatalogEntry.bind(storage),
        listCatalogEntries: storage.listCatalogEntries.bind(storage),
        deleteCatalogEntry: storage.deleteCatalogEntry.bind(storage),
        putDocument: storage.putDocument.bind(storage),
        listDocuments: storage.listDocuments.bind(storage),
        snapshot: storage.snapshot.bind(storage),
        restore: storage.restore.bind(storage),
        close: storage.close.bind(storage),
    };
}

test("a direct SQLite import rolls back its schema, data and documents before a corrected retry", () => {
    const storage = new SqliteStorage();

    try {
        const before = storage.snapshot();
        const broken = parseAml(
            `<AML>${schema}
                <Item type="AtomicPart" action="add" id="BROKEN">
                    <label>Original</label><next_part>MISSING</next_part>
                </Item>
            </AML>`,
            "broken.xml",
        );

        expect(() => new PackageImporter(storage).import([broken])).toThrow(PackageImportError);
        expect(storage.getItemType("AtomicPart")).toBeUndefined();
        expect(storage.listItemTypes()).toEqual([]);
        expect(storage.listCatalogEntries()).toEqual([]);
        expect(storage.listDocuments()).toEqual([]);
        expect(storage.snapshot()).toEqual(before);

        const corrected = parseAml(
            `<AML>${schema.replace("<data_type>string</data_type>", "<data_type>integer</data_type>")}
                <Item type="AtomicPart" action="add" id="CORRECTED"><label>7</label></Item>
            </AML>`,
            "corrected.xml",
        );
        new PackageImporter(storage).import([corrected]);

        expect(storage.getItem("AtomicPart", "CORRECTED")?.properties).toEqual({ label: 7 });
        expect(storage.listDocuments().map((document) => document.path)).toEqual(["corrected.xml"]);
    } finally {
        storage.close();
    }
});

test("a retained importer reads current stored data and starts a new plan for every call", () => {
    const storage = new SqliteStorage();

    try {
        const importer = new PackageImporter(storage);
        importer.import([
            parseAml(
                `<AML>${schema}<Item type="AtomicPart" action="add" id="EXISTING"><label>Original</label></Item></AML>`,
                "original.xml",
            ),
        ]);
        storage.updateItem("AtomicPart", "EXISTING", { label: "Runtime change" });

        const report = importer.import([
            parseAml(
                '<Item type="AtomicPart" action="add" id="LINK"><next_part>EXISTING</next_part></Item>',
                "later.xml",
            ),
        ]);

        expect(report.added).toBe(1);
        expect(report.updated).toBe(0);
        expect(report.documents.map((document) => document.path)).toEqual(["later.xml"]);
        expect(storage.getItem("AtomicPart", "EXISTING")?.properties.label).toBe("Runtime change");
        expect(storage.getItem("AtomicPart", "LINK")?.properties.next_part).toBe("EXISTING");

        expect(() =>
            importer.import([
                parseAml(
                    '<Item type="AtomicPart" action="add" id="BAD"><next_part>MISSING</next_part></Item>',
                    "broken.xml",
                ),
            ]),
        ).toThrow(PackageImportError);

        const retry = importer.import([
            parseAml(
                '<Item type="AtomicPart" action="edit" id="LINK"><label>Retry</label></Item>',
                "retry.xml",
            ),
        ]);

        expect(retry.updated).toBe(1);
        expect(storage.getItem("AtomicPart", "BAD")).toBeUndefined();
        expect(storage.getItem("AtomicPart", "LINK")?.properties.label).toBe("Retry");
    } finally {
        storage.close();
    }
});

test("a rejected import preserves its caller's transaction and a later import can still roll back", () => {
    const storage = new SqliteStorage();

    try {
        const original = parseAml(
            `<AML>${schema}<Item type="AtomicPart" action="add" id="EXISTING"><label>Original</label></Item></AML>`,
            "original.xml",
        );
        new PackageImporter(storage).import([original]);
        const definition = storage.getItemType("AtomicPart");
        storage.transactions.begin();
        storage.updateItem("AtomicPart", "EXISTING", { label: "Caller" });

        const broken = parseAml(
            `<AML>
                <Item type="ItemType" action="edit" id="ATOMIC_TYPE"><Relationships>
                    <Item type="Property" action="add" id="ATOMIC_EXTRA">
                        <name>extra</name><data_type>integer</data_type>
                    </Item>
                </Relationships></Item>
                <Item type="AtomicPart" action="add" id="BROKEN"><next_part>MISSING</next_part></Item>
            </AML>`,
            "broken.xml",
        );

        expect(() => new PackageImporter(storage).import([broken])).toThrow(PackageImportError);
        expect(storage.getItemType("AtomicPart")).toEqual(definition);
        expect(storage.getItem("AtomicPart", "EXISTING")?.properties.label).toBe("Caller");
        expect(storage.getItem("AtomicPart", "BROKEN")).toBeUndefined();
        expect(storage.getCatalogEntry("Property", "ATOMIC_EXTRA")).toBeUndefined();

        const later = parseAml(
            '<Item type="AtomicPart" action="add" id="LATER"><label>Later</label></Item>',
            "later.xml",
        );
        new PackageImporter(storage).import([later]);
        storage.transactions.rollback();

        expect(storage.getItem("AtomicPart", "EXISTING")?.properties.label).toBe("Original");
        expect(storage.getItem("AtomicPart", "LATER")).toBeUndefined();
        expect(storage.listDocuments()).toHaveLength(1);
        expect(storage.listDocuments()[0]?.xml).toBe(original.xml);
    } finally {
        storage.close();
    }
});

test("adapters without a package write scope preserve the ordinary runtime import contract", () => {
    using engine = createEngine({ storage: portable(new SqliteStorage()) });
    const document = parseAml(
        `<AML>${schema}<Item type="AtomicPart" action="add" id="EXISTING"><label>Original</label></Item></AML>`,
        "original.xml",
    );
    engine.runtime.executeSync(importPackageDocuments, [document]);
    const before = engine.storage.snapshot();
    const broken = parseAml(
        `<AML>
            <Item type="ItemType" action="edit" id="ATOMIC_TYPE"><Relationships>
                <Item type="Property" action="add" id="PORTABLE_EXTRA">
                    <name>extra</name><data_type>integer</data_type>
                </Item>
            </Relationships></Item>
            <Item type="AtomicPart" action="edit" id="EXISTING"><label>Changed</label></Item>
            <Item type="AtomicPart" action="add" id="BROKEN"><next_part>MISSING</next_part></Item>
        </AML>`,
        "broken.xml",
    );

    expect(() => engine.runtime.executeSync(importPackageDocuments, [broken])).toThrow(
        PackageImportError,
    );
    expect(engine.storage.snapshot()).toEqual(before);
    expect(engine.storage.getItem("AtomicPart", "EXISTING")?.properties.label).toBe("Original");
    expect(engine.storage.getItem("AtomicPart", "BROKEN")).toBeUndefined();

    engine.runtime.executeSync(importPackageDocuments, [
        parseAml(
            '<Item type="AtomicPart" action="edit" id="EXISTING"><label>After rollback</label></Item>',
            "later.xml",
        ),
    ]);
    expect(engine.storage.getItem("AtomicPart", "EXISTING")?.properties.label).toBe(
        "After rollback",
    );
});
