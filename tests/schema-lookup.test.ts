import { expect, test } from "bun:test";

import { propertyFor } from "../src/storage/properties.js";
import { SqliteStorage } from "../src/storage/sqlite/index.js";
import type { ItemTypeDefinition, PropertyDefinition } from "../src/storage/types.js";

test("a shallow freeze cannot hide later property mutations from schema lookup", () => {
    const properties: PropertyDefinition[] = [{ name: "label", dataType: "string" }];
    const definition = Object.freeze({ id: "LOOKUP", name: "Lookup", properties });

    expect(propertyFor(definition, "label")?.dataType).toBe("string");
    properties[0] = { name: "label", dataType: "integer" };
    properties.push({ name: "added", dataType: "boolean" });
    expect(propertyFor(definition, "label")?.dataType).toBe("integer");
    expect(propertyFor(definition, "added")?.dataType).toBe("boolean");
    expect(propertyFor(definition, "Label")).toBeUndefined();
});

test("indexed writes follow schema expansion, rollback and restoring an earlier database image", () => {
    const storage = new SqliteStorage();
    const definition: ItemTypeDefinition = {
        id: "LOOKUP",
        name: "Lookup",
        properties: [{ name: "label", dataType: "string" }],
    };

    try {
        storage.defineItemType(definition);
        storage.insertItem({ type: "Lookup", id: "ONE", properties: { label: "Original" } });
        const original = storage.snapshot();
        storage.transactions.begin();
        storage.defineItemType({
            ...definition,
            properties: [...definition.properties, { name: "added", dataType: "integer" }],
        });
        storage.updateItem("Lookup", "ONE", { added: 7 });
        expect(storage.getItem("Lookup", "ONE")?.properties.added).toBe(7);
        storage.transactions.rollback();
        expect(() => storage.updateItem("Lookup", "ONE", { added: 7 })).toThrow("Unknown");
        storage.defineItemType({
            ...definition,
            properties: [...definition.properties, { name: "added", dataType: "string" }],
        });
        storage.updateItem("Lookup", "ONE", { added: "New type" });
        expect(storage.getItem("Lookup", "ONE")?.properties.added).toBe("New type");
        expect(() => storage.updateItem("Lookup", "ONE", { added: 7 })).toThrow("requires a text");
        storage.restore(original);
        expect(storage.getItem("Lookup", "ONE")?.properties).toEqual({ label: "Original" });
        expect(() => storage.updateItem("Lookup", "ONE", { added: "Gone" })).toThrow("Unknown");
        expect(() => storage.updateItem("Lookup", "ONE", { Label: "Wrong case" })).toThrow(
            "Unknown",
        );
    } finally {
        storage.close();
    }
});
