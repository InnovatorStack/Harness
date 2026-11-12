import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withTemporaryDirectory } from "../src/core/resources.js";
import { createEngine } from "../src/engine.js";
import { captureEngine, openEngine } from "../src/engine/instance.js";
import { SqliteStorage } from "../src/storage/sqlite/storage.js";

const schema = {
    id: "CHECKPOINT_RECORD",
    name: "CheckpointRecord",
    properties: [{ name: "name", dataType: "string" }],
};

test("reset rolls back changed rows and schema without deserializing another database", () => {
    using engine = createEngine();
    engine.storage.defineItemType(schema);
    const original = engine.seed(schema.name, { name: "Baseline" });
    engine.checkpoint();
    const restore = spyOn(engine.storage, "restore");

    try {
        for (let index = 0; index < 5; index += 1) {
            engine.storage.defineItemType({
                ...schema,
                properties: [...schema.properties, { name: "temporary", dataType: "string" }],
            });
            engine.storage.updateItem(schema.name, original.id, {
                name: "Changed",
                temporary: "Local",
            });
            engine.seed(schema.name, { name: "Another row" });
            engine.reset();
            expect(engine.storage.listItems(schema.name)).toEqual([
                {
                    type: schema.name,
                    id: original.id,
                    properties: { name: "Baseline" },
                },
            ]);
            expect(engine.storage.getItemType(schema.name)?.properties).toEqual(schema.properties);
        }

        expect(restore).not.toHaveBeenCalled();
    } finally {
        restore.mockRestore();
    }
});

test("public snapshots include current writes while reset retains its earlier checkpoint", () => {
    using engine = createEngine();
    engine.storage.defineItemType(schema);
    const original = engine.seed(schema.name, { name: "Baseline" });
    engine.checkpoint();
    engine.storage.updateItem(schema.name, original.id, { name: "Visible in snapshot" });
    const snapshot = engine.storage.snapshot();
    const copy = new SqliteStorage();

    try {
        copy.restore(snapshot);
        expect(copy.getItem(schema.name, original.id)?.properties.name).toBe("Visible in snapshot");
        engine.reset();
        expect(engine.storage.getItem(schema.name, original.id)?.properties.name).toBe("Baseline");
        engine.storage.updateItem(schema.name, original.id, { name: "Another change" });
        engine.reset();
        expect(engine.storage.getItem(schema.name, original.id)?.properties.name).toBe("Baseline");
    } finally {
        copy.close();
    }
});

test("request rollback and snapshot guards remain independent of the setup savepoint", () => {
    using engine = createEngine();
    engine.storage.defineItemType(schema);
    const original = engine.seed(schema.name, { name: "Baseline" });
    engine.checkpoint();
    expect(() => engine.storage.transactions.commit()).toThrow("No storage transaction");
    engine.storage.transactions.begin();
    engine.storage.updateItem(schema.name, original.id, { name: "Uncommitted" });
    expect(() => engine.storage.snapshot()).toThrow("Cannot snapshot");
    expect(() => engine.storage.transactions.begin()).toThrow("already active");
    engine.storage.transactions.rollback();
    expect(engine.storage.getItem(schema.name, original.id)?.properties.name).toBe("Baseline");
    engine.reset();
    expect(engine.storage.getItem(schema.name, original.id)?.properties.name).toBe("Baseline");
});

test("file-backed engines retain committed records after closing", async () => {
    await withTemporaryDirectory(
        join(tmpdir(), "harness-durable-checkpoint-"),
        async (directory) => {
            const database = join(directory, "owned.sqlite");

            {
                using engine = createEngine({ database });
                engine.storage.defineItemType(schema);
                engine.seed(schema.name, { name: "Persisted" });
            }

            const reopened = new SqliteStorage(database);

            try {
                expect(reopened.listItems(schema.name).map((row) => row.properties.name)).toEqual([
                    "Persisted",
                ]);
            } finally {
                reopened.close();
            }
        },
    );
});

test("sequential worlds reuse a clean native database while disposed wrappers stay closed", () => {
    const first = createEngine();
    first.storage.defineItemType(schema);
    first.seed(schema.name, { name: "Baseline" });
    first.checkpoint();
    const image = captureEngine(first);
    const disposed = first.storage;
    first.seed(schema.name, { name: "Private change" });
    first.close();
    const copies = spyOn(Database, "deserialize");

    try {
        for (let index = 0; index < 5; index += 1) {
            using next = openEngine({}, image);
            expect(next.storage).not.toBe(disposed);
            expect(next.storage.listItems(schema.name).map((row) => row.properties.name)).toEqual([
                "Baseline",
            ]);
            expect(() =>
                disposed.insertItem({ type: schema.name, id: "LATE", properties: {} }),
            ).toThrow("closed");
            next.seed(schema.name, { name: "Another private change" });
        }

        expect(copies).not.toHaveBeenCalled();
    } finally {
        copies.mockRestore();
    }
});

test("concurrent worlds hold independent native connections", () => {
    const first = createEngine();
    first.storage.defineItemType(schema);
    first.seed(schema.name, { name: "Baseline" });
    first.checkpoint();
    const image = captureEngine(first);
    first.close();
    using left = openEngine({}, image);
    using right = openEngine({}, image);
    left.seed(schema.name, { name: "Only left" });
    expect(right.storage.listItems(schema.name).map((row) => row.properties.name)).toEqual([
        "Baseline",
    ]);
    right.seed(schema.name, { name: "Only right" });
    expect(
        left.storage
            .listItems(schema.name)
            .map((row) => row.properties.name)
            .sort((left, right) => String(left).localeCompare(String(right))),
    ).toEqual(["Baseline", "Only left"]);
});
