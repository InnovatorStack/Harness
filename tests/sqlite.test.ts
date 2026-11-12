import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StorageError, SqliteStorage } from "../src/storage/sqlite/index.js";
import type { CatalogEntry, ItemTypeDefinition } from "../src/storage/types.js";

const partType: ItemTypeDefinition = {
    id: "PART-TYPE",
    name: "Part",
    tableName: "part_data",
    properties: [
        { name: "name", dataType: "string" },
        { name: "quantity", dataType: "integer" },
        { name: "active", dataType: "boolean" },
        { name: "cost", dataType: "decimal" },
    ],
};

const source = { file: "part.xml", line: 1, column: 1, path: "/AML/Item[1]" };
const catalogEntry: CatalogEntry = {
    id: "PART-TYPE",
    type: "ItemType",
    properties: { name: "Part" },
    attributes: { action: "add" },
    source,
};

describe("SqliteStorage", () => {
    const resources: SqliteStorage[] = [];
    const directories: string[] = [];

    function create(filename?: string): SqliteStorage {
        const storage = new SqliteStorage(filename);
        resources.push(storage);

        return storage;
    }

    afterEach(() => {
        for (const storage of resources.splice(0)) {
            storage.close();
        }

        for (const directory of directories.splice(0)) {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    test("generates relational tables and preserves null, omission, empty text, zero and decimals", () => {
        const storage = create();
        storage.defineItemType(partType);
        storage.insertItem({
            type: "Part",
            id: "A",
            properties: {
                name: "",
                quantity: 0,
                active: 0,
                cost: "123456789012345678.1234",
            },
        });
        storage.insertItem({ type: "Part", id: "B", properties: { name: null } });
        storage.insertItem({ type: "Part", id: "C", properties: {} });

        expect(storage.getItem("Part", "A")?.properties).toEqual({
            name: "",
            quantity: 0,
            active: 0,
            cost: "123456789012345678.1234",
        });
        expect(storage.getItem("Part", "B")?.properties).toEqual({ name: null });
        expect(storage.getItem("Part", "C")?.properties).toEqual({});

        const database = Database.deserialize(storage.snapshot(), {
            readonly: true,
        });

        try {
            expect(
                database
                    .query("SELECT id, name, quantity, cost FROM part_data WHERE id = 'A'")
                    .get(),
            ).toEqual({
                id: "A",
                name: "",
                quantity: 0,
                cost: "123456789012345678.1234",
            });
        } finally {
            database.close();
        }
    });

    test("relationship records share normal item operations and physical reference columns", () => {
        const storage = create();
        storage.defineItemType({
            id: "BOM-TYPE",
            name: "Part BOM",
            isRelationship: true,
            properties: [{ name: "quantity", dataType: "integer" }],
        });
        storage.insertItem({
            type: "Part BOM",
            id: "REL",
            properties: { source_id: "SOURCE", related_id: "RELATED", quantity: 2 },
        });
        storage.updateItem("Part BOM", "REL", { quantity: 0, related_id: null });
        expect(storage.getItem("Part BOM", "REL")?.properties).toEqual({
            source_id: "SOURCE",
            related_id: null,
            quantity: 0,
        });
    });

    test("metadata reads remain immutable and follow transaction rollback and snapshot restore", () => {
        const storage = create();
        storage.defineItemType(partType);
        const snapshot = storage.snapshot();
        const original = storage.getItemType("Part");

        if (!original) {
            throw new Error("Expected the original ItemType.");
        }

        expect(Reflect.set(original, "name", "Changed externally")).toBe(false);
        expect(storage.getItemType("Part")?.name).toBe("Part");

        const expanded = {
            ...partType,
            properties: [...partType.properties, { name: "note", dataType: "string" }],
        };
        storage.transactions.begin();
        storage.defineItemType(expanded);
        expect(
            storage.getItemType("Part")?.properties.some((property) => property.name === "note"),
        ).toBe(true);
        storage.transactions.rollback();
        expect(storage.getItemType("Part")).toEqual(partType);

        storage.defineItemType(expanded);
        expect(storage.getItemType("Part")).toEqual(expanded);
        storage.restore(snapshot);
        expect(storage.getItemType("Part")).toEqual(partType);
    });

    test("outer rollback restores schema, catalog, documents and item mutations together", () => {
        const storage = create();
        storage.defineItemType(partType);
        storage.insertItem({ type: "Part", id: "A", properties: { quantity: 1 } });
        storage.transactions.begin();
        storage.defineItemType({
            ...partType,
            properties: [...partType.properties, { name: "description", dataType: "text" }],
        });
        storage.defineItemType({
            id: "NEW-TYPE",
            name: "Temporary",
            properties: [],
        });
        storage.updateItem("Part", "A", { quantity: 9, description: "changed" });
        storage.putCatalogEntry(catalogEntry);
        storage.putDocument({ path: "part.xml", sha256: "hash", xml: "<AML/>" });
        storage.transactions.rollback();

        expect(storage.getItemType("Temporary")).toBeUndefined();
        expect(storage.getItemType("Part")).toEqual(partType);
        expect(storage.getItem("Part", "A")?.properties).toEqual({ quantity: 1 });
        expect(storage.listCatalogEntries()).toEqual([]);
        expect(storage.listDocuments()).toEqual([]);
        expect(() => storage.updateItem("Part", "A", { description: "missing" })).toThrow(
            StorageError,
        );
    });

    test("additive schema changes work without backfilling omitted properties", () => {
        const storage = create();
        storage.defineItemType(partType);
        storage.insertItem({
            type: "Part",
            id: "A",
            properties: { name: "existing" },
        });
        storage.defineItemType({
            ...partType,
            properties: [...partType.properties, { name: "description", dataType: "text" }],
        });
        expect(storage.getItem("Part", "A")?.properties).toEqual({
            name: "existing",
        });
        storage.updateItem("Part", "A", { description: null });
        expect(storage.getItem("Part", "A")?.properties).toEqual({
            name: "existing",
            description: null,
        });

        expect(() => storage.defineItemType({ ...partType, properties: [] })).toThrow(
            "Cannot remove or change property",
        );
        expect(storage.getItemType("Part")?.properties).toHaveLength(5);
    });

    test("quoted table and property names remain identifiers", () => {
        const storage = create();
        storage.defineItemType({
            id: "QUOTED",
            name: 'select " table',
            properties: [{ name: 'value"; DROP TABLE Part; --', dataType: "string" }],
        });
        storage.insertItem({
            type: 'select " table',
            id: "A",
            properties: { 'value"; DROP TABLE Part; --': "safe" },
        });
        expect(storage.getItem('select " table', "A")?.properties).toEqual({
            'value"; DROP TABLE Part; --': "safe",
        });
    });

    test("rejects name collisions, internal names, unsupported types and incompatible definitions", () => {
        const storage = create();
        storage.defineItemType(partType);
        expect(() =>
            storage.defineItemType({
                id: "OTHER",
                name: "Other",
                tableName: "PART_DATA",
                properties: [],
            }),
        ).toThrow("already in use");
        expect(() =>
            storage.defineItemType({
                id: "INTERNAL",
                name: "_harness_catalog",
                properties: [],
            }),
        ).toThrow("reserved");
        expect(() =>
            storage.defineItemType({
                id: "SQLITE",
                name: "sqlite_custom",
                properties: [],
            }),
        ).toThrow("reserved");
        expect(() =>
            storage.defineItemType({
                id: "DUP",
                name: "Duplicate",
                properties: [
                    { name: "name", dataType: "string" },
                    { name: "NAME", dataType: "string" },
                ],
            }),
        ).toThrow("Duplicate property");
        expect(() =>
            storage.defineItemType({
                id: "FOREIGN",
                name: "Foreign",
                properties: [{ name: "unsupported_name", dataType: "unsupported" }],
            }),
        ).toThrow("unsupported storage data type");
        expect(() => storage.defineItemType({ ...partType, id: "OTHER-ID" })).toThrow(
            "Cannot change",
        );
        expect(storage.listItemTypes()).toEqual([partType]);
    });

    test("rejects lossy numeric input and unknown properties before mutation", () => {
        const storage = create();
        storage.defineItemType(partType);

        for (const properties of [
            { quantity: 1.5 },
            { quantity: Number.MAX_SAFE_INTEGER + 1 },
            { quantity: Number.NaN },
            { active: 2 },
            { name: 10 },
            { unknown: "value" },
            { id: "OTHER" },
        ]) {
            expect(() => storage.insertItem({ type: "Part", id: "A", properties })).toThrow(
                StorageError,
            );
        }

        expect(storage.listItems("Part")).toEqual([]);
        storage.insertItem({ type: "Part", id: "A", properties: {} });
        expect(() => storage.insertItem({ type: "Part", id: "a", properties: {} })).toThrow(
            "already exists",
        );
        expect(() => storage.updateItem("Part", "missing", {})).toThrow("does not exist");
        expect(() => storage.getItem("Missing", "A")).toThrow("Load its package");
    });

    test("snapshots reset all stored state and remain independent of later mutations", () => {
        const storage = create();
        storage.defineItemType(partType);
        storage.insertItem({ type: "Part", id: "A", properties: { quantity: 1 } });
        storage.putCatalogEntry(catalogEntry);
        const baseline = storage.snapshot();
        storage.updateItem("Part", "A", { quantity: 2 });
        storage.putCatalogEntry({
            ...catalogEntry,
            properties: { name: "Changed" },
        });
        storage.putDocument({ path: "later.xml", sha256: "hash", xml: "<AML/>" });
        storage.restore(baseline);
        expect(storage.getItem("Part", "A")?.properties).toEqual({ quantity: 1 });
        expect(storage.getCatalogEntry("ItemType", "PART-TYPE")).toEqual(catalogEntry);
        expect(storage.listDocuments()).toEqual([]);
    });

    test("restoring a file database preserves its filename and durable contents", () => {
        const directory = mkdtempSync(join(tmpdir(), "innovator-harness-sqlite-"));
        directories.push(directory);
        const filename = join(directory, "world.sqlite");
        const storage = create(filename);
        storage.defineItemType(partType);
        storage.insertItem({ type: "Part", id: "A", properties: { quantity: 1 } });
        const baseline = storage.snapshot();
        storage.updateItem("Part", "A", { quantity: 2 });
        storage.restore(baseline);
        storage.insertItem({ type: "Part", id: "B", properties: { quantity: 3 } });
        storage.close();

        const reopened = create(filename);
        expect(reopened.listItems("Part")).toEqual([
            { type: "Part", id: "A", properties: { quantity: 1 } },
            { type: "Part", id: "B", properties: { quantity: 3 } },
        ]);
    });

    test("invalid snapshot and transaction-state failures preserve the current database", () => {
        const storage = create();
        storage.defineItemType(partType);
        expect(() => storage.restore(new Uint8Array([1, 2, 3]))).toThrow(
            "invalid InnovatorHarness",
        );
        expect(storage.getItemType("Part")).toEqual(partType);
        storage.transactions.begin();
        expect(() => storage.transactions.begin()).toThrow("already active");
        expect(() => storage.snapshot()).toThrow("Cannot snapshot");
        expect(() => storage.restore(new Uint8Array())).toThrow("Cannot restore");
        storage.transactions.rollback();
        expect(() => storage.transactions.commit()).toThrow("No storage transaction");
        storage.close();
        storage.close();
        expect(() => storage.listItemTypes()).toThrow("closed");
    });
});
