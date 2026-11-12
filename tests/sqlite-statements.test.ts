import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";

import { selectQuery } from "../src/queries/types.js";
import { SqliteStorage } from "../src/storage/sqlite/index.js";
import { SqliteStatements } from "../src/storage/sqlite/statements.js";

const storages: SqliteStorage[] = [];

afterEach(() => {
    for (const storage of storages.splice(0)) {
        storage.close();
    }
});

test("SQL plan retention evicts old statements and releases the remainder on cleanup", () => {
    const database = new Database(":memory:");
    const statements = new SqliteStatements(() => database);

    try {
        const first = statements.query("SELECT ? AS value /* first */");
        expect(first.get(1)).toEqual({ value: 1 });
        expect(statements.query("SELECT ? AS value /* first */")).toBe(first);

        for (let index = 0; index < 1000; index += 1) {
            expect(statements.query(`SELECT ? AS value /* ${index} */`).get(index)).toEqual({
                value: index,
            });
        }

        expect(first.isFinalized).toBe(true);
        const recent = statements.query("SELECT ? AS value /* recent */");
        expect(recent.get(2)).toEqual({ value: 2 });
        statements.clear();
        expect(recent.isFinalized).toBe(true);
        expect(statements.query("SELECT ? AS value /* recent */").get(3)).toEqual({ value: 3 });
    } finally {
        statements.clear();
        database.close();
    }
});

test.each(["missing", "malformed", "reserved"])(
    "all item read paths reject %s presence metadata instead of dropping or inventing values",
    (corruption) => {
        const storage = new SqliteStorage();
        storages.push(storage);
        storage.defineItemType({
            id: "RECORD_TYPE",
            name: "Record",
            properties: [{ name: "name", dataType: "string" }],
        });
        storage.insertItem({ type: "Record", id: "RECORD", properties: { name: "Original" } });
        const database = Database.deserialize(storage.snapshot());

        try {
            if (corruption === "missing") {
                database.run("DELETE FROM _harness_presence");
            } else {
                const properties = corruption === "malformed" ? "{" : '["_harness_presence"]';
                database.query("UPDATE _harness_presence SET properties = ?").run(properties);
            }

            storage.restore(new Uint8Array(database.serialize()));
        } finally {
            database.close();
        }

        expect(() => storage.getItem("Record", "RECORD")).toThrow();
        expect(() => storage.listItems("Record")).toThrow();
        expect(() =>
            storage[selectQuery]("Record", { kind: "constant", value: true }, () => {}),
        ).toThrow();
    },
);
