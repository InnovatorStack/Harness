import { afterEach, describe, expect, test } from "bun:test";

import { createEngine } from "../src/engine.js";
import type { Engine } from "../src/engine.js";
import { Item } from "../src/items/item.js";
import type { MethodExecutor, MethodPorts } from "../src/methods/types.js";
import { importPackageDocuments } from "../src/packages/module.js";
import { parseAml } from "../src/packages/parser.js";

type Handler = (item: Item, ports: MethodPorts) => Item | Promise<Item>;

const worlds: Engine[] = [];
const userId = "AA000000000000000000000000000001";

afterEach(() => {
    for (const world of worlds.splice(0)) {
        world.close();
    }
});

function setup(handlers: Readonly<Record<string, Handler>> = {}, manual = false): Engine {
    const executor: MethodExecutor = {
        language: "Conformance",

        async execute(method, item, ports) {
            const handler = handlers[method.name];

            if (!handler) {
                throw new Error(`Missing test handler '${method.name}'.`);
            }

            return await handler(item, ports);
        },
    };
    const engine = createEngine({
        userId: () => userId,

        executors: [executor],
    });
    worlds.push(engine);
    load(
        engine,
        `
    <Item type="ItemType" action="add" id="VERSIONED_RECORD">
      <name>VersionedRecord</name>
      <is_versionable>1</is_versionable>
      <manual_versioning>${manual ? "1" : "0"}</manual_versioning>
      <Relationships>
        <Item type="Property" action="add"><name>name</name><data_type>string</data_type><is_required>1</is_required></Item>
        <Item type="Property" action="add"><name>note</name><data_type>string</data_type></Item>
      </Relationships>
    </Item>
    <Item type="ItemType" action="add" id="RECORD_LINK"><name>RecordLink</name><is_relationship>1</is_relationship></Item>
    <Item type="RelationshipType" action="add">
      <name>RecordLink</name><relationship_id>RECORD_LINK</relationship_id>
      <source_id>VERSIONED_RECORD</source_id><related_id>VERSIONED_RECORD</related_id>
    </Item>
  `,
    );

    return engine;
}

function load(engine: Engine, xml: string): void {
    engine.runtime.executeSync(importPackageDocuments, [
        parseAml(`<AML>${xml}</AML>`, "versioning.xml"),
    ]);
}

function bind(engine: Engine, event: string, handler: string, required = false): void {
    load(
        engine,
        `
    <Item type="Method" action="add" id="METHOD_${handler}">
      <name>${handler}</name><method_type>Conformance</method_type><method_code>test executor</method_code>
    </Item>
    <Item type="Server Event" action="add">
      <source_id>VERSIONED_RECORD</source_id><related_id>METHOD_${handler}</related_id>
      <server_event>${event}</server_event><sort_order>10</sort_order><is_required>${required ? "1" : "0"}</is_required>
    </Item>
  `,
    );
}

async function add(engine: Engine, name = "Original"): Promise<Item> {
    const request = Item.create("VersionedRecord", "add");
    request.setProperty("name", name);

    return await engine.apply(request);
}

function request(action: string, id: string, name?: string): Item {
    const item = Item.create("VersionedRecord", action);
    item.setProperty("id", id);

    if (name !== undefined) {
        item.setProperty("name", name);
    }

    return item;
}

describe("versionable actions", () => {
    test("edit creates a new ID, retains config_id and leaves the original business values readable", async () => {
        const engine = setup();
        const original = await add(engine);
        expect(original.node.properties).toMatchObject({
            config_id: original.getID(),
            generation: 1,
            is_current: 1,
        });

        const updated = await engine.apply(request("edit", original.getID(), "Changed"));
        expect(updated.getID()).not.toBe(original.getID());
        expect(updated.node.properties).toMatchObject({
            config_id: original.getID(),
            generation: 2,
            is_current: 1,
            name: "Changed",
            locked_by_id: null,
        });
        const old = await engine.apply(request("get", original.getID()));
        expect(old.node.properties).toMatchObject({
            name: "Original",
            generation: 1,
            is_current: 0,
            locked_by_id: null,
        });

        const current = Item.create("VersionedRecord", "get");
        current.setProperty("config_id", original.getID());
        expect((await engine.apply(current)).getID()).toBe(updated.getID());
        current.setProperty("is_current", 0);
        expect((await engine.apply(current)).getID()).toBe(original.getID());
        expect(engine.trace.find((event) => event.name === "version")).toMatchObject({
            before: { id: original.getID() },
            after: { id: updated.getID() },
            outcome: "committed",
        });
    });

    test("the first update after lock versions once; subsequent saves in that lock cycle reuse the generation", async () => {
        const engine = setup();
        const original = await add(engine);
        await engine.apply(request("lock", original.getID()));
        const first = await engine.apply(request("update", original.getID(), "First save"));
        const second = await engine.apply(request("update", first.getID(), "Second save"));
        expect(second.getID()).toBe(first.getID());
        expect(second.node.properties).toMatchObject({
            generation: 2,
            name: "Second save",
            new_version: 0,
            locked_by_id: userId,
        });

        await engine.apply(request("unlock", second.getID()));
        const third = await engine.apply(request("edit", second.getID(), "New lock cycle"));
        expect(third.node.properties.generation).toBe(3);
        expect(third.getID()).not.toBe(second.getID());
        expect(engine.storage.listItems("VersionedRecord")).toHaveLength(3);
    });

    test("captured current generations retain historical config_id and before-version changes affect only the new generation", async () => {
        const engine = setup({
            before: (item) => {
                item.setProperty("note", "Changed by the original version hook");

                return item;
            },
        });
        bind(engine, "onBeforeVersion", "before");
        const current = engine.seed("VersionedRecord", {
            name: "Imported current generation",
            config_id: "HISTORICAL_CONFIG",
            generation: 47,
            is_current: 1,
            note: "Historical value",
        });
        const updated = await engine.apply(request("edit", current.id, "Changed"));
        expect(updated.node.properties).toMatchObject({
            config_id: "HISTORICAL_CONFIG",
            generation: 48,
            note: "Changed by the original version hook",
        });
        expect(engine.inspect(current).properties).toMatchObject({
            generation: 47,
            is_current: 0,
            note: "Historical value",
        });
    });

    test("explicit version locks the new generation and cannot take another User's lock", async () => {
        const engine = setup({}, true);
        const original = await add(engine);
        const version = await engine.apply(
            request("version", original.getID(), "Explicitly versioned"),
        );
        expect(version.node.properties).toMatchObject({ generation: 2, locked_by_id: userId });
        expect(
            engine.storage.getItem("VersionedRecord", original.getID())?.properties.locked_by_id,
        ).toBeNull();
        const other = engine.seed("VersionedRecord", {
            name: "Locked by someone else",
            locked_by_id: "OTHER_USER",
        });
        await expect(engine.apply(request("version", other.id))).rejects.toThrow(
            "locked by another User",
        );
        expect(engine.inspect(other).properties.generation).toBe(1);
    });

    test("version=0 updates in place and manual ItemTypes version only through the version action", async () => {
        const automatic = setup();
        const original = await add(automatic);
        const edit = request("edit", original.getID(), "No new generation");
        edit.setAttribute("version", "0");
        expect((await automatic.apply(edit)).getID()).toBe(original.getID());
        expect(automatic.storage.listItems("VersionedRecord")).toHaveLength(1);

        const manual = setup({}, true);
        const manualOriginal = await add(manual);
        const changed = await manual.apply(request("edit", manualOriginal.getID(), "Manual save"));
        expect(changed.getID()).toBe(manualOriginal.getID());
        await manual.apply(request("lock", changed.getID()));
        const version = await manual.apply(request("version", changed.getID(), "Explicit version"));
        expect(version.node.properties).toMatchObject({
            generation: 2,
            config_id: manualOriginal.getID(),
            name: "Explicit version",
            locked_by_id: userId,
        });
    });

    test("version and update hooks run before the business write, and edit includes lock and unlock hooks", async () => {
        const calls: string[] = [];
        let newId = "";
        const handlers: Record<string, Handler> = {};
        const names = [
            "onBeforeLock",
            "onAfterLock",
            "onBeforeVersion",
            "onAfterVersion",
            "onBeforeUpdate",
            "onAfterUpdate",
            "onBeforeUnlock",
            "onAfterUnlock",
        ];

        for (const name of names) {
            // Event handlers intentionally update the shared result inspected after execution.
            // oxlint-disable-next-line no-loop-func
            handlers[name] = (item) => {
                calls.push(name);

                if (name === "onAfterVersion") {
                    newId = item.getID();
                    expect(item.getProperty("name")).toBe("Original");
                }

                if (name === "onBeforeUpdate") {
                    expect(item.getID()).toBe(newId);
                    item.setProperty("note", "Set by the native update hook");
                }

                return item;
            };
        }

        const engine = setup(handlers);

        for (const name of names) {
            bind(engine, name, name);
        }

        const original = await add(engine);
        const updated = await engine.apply(request("edit", original.getID(), "Changed"));
        expect(calls).toEqual(names);
        expect(engine.storage.getItem("VersionedRecord", updated.getID())?.properties.note).toBe(
            "Set by the native update hook",
        );
    });

    test("failed after-update hooks roll back the generation, relationships, locks and nested writes together", async () => {
        const engine = setup({
            reject: async (_item, ports) => {
                const nested = Item.create("VersionedRecord", "add");
                nested.setProperty("name", "Must roll back");
                await ports.apply(nested);

                return Item.error("Business rule rejected the save");
            },
        });
        const original = await add(engine);
        const link = engine.seed("RecordLink", {
            source_id: original.getID(),
            related_id: original.getID(),
            behavior: "fixed",
        });
        bind(engine, "onAfterUpdate", "reject");
        const result = await engine.apply(request("edit", original.getID(), "Changed"));
        expect(result.getErrorString()).toBe("Business rule rejected the save");
        expect(engine.storage.listItems("VersionedRecord")).toHaveLength(1);
        expect(
            engine.storage.getItem("VersionedRecord", original.getID())?.properties,
        ).toMatchObject({
            name: "Original",
            is_current: 1,
        });
        expect(
            engine.storage.getItem("VersionedRecord", original.getID())?.properties.locked_by_id,
        ).toBeUndefined();
        expect(engine.storage.listItems("RecordLink")).toHaveLength(1);
        expect(engine.inspect(link).properties.source_id).toBe(original.getID());
        expect(
            engine.trace
                .filter((event) => ["version", "copy", "update", "lock"].includes(event.name))
                .every((event) => event.outcome === "rolledBack"),
        ).toBe(true);
    });

    test("copies owned relationships to the new generation while preserving historical fixed targets", async () => {
        const engine = setup();
        const original = await add(engine);
        const target = await add(engine, "Related item");
        const relationship = engine.seed("RecordLink", {
            source_id: original.getID(),
            related_id: target.getID(),
            behavior: "fixed",
        });
        const updated = await engine.apply(request("edit", original.getID(), "Changed"));
        const links = engine.storage.listItems("RecordLink");
        expect(links).toHaveLength(2);
        const copied = links.find((link) => link.properties.source_id === updated.getID());
        expect(copied?.id).not.toBe(relationship.id);
        expect(copied?.properties.related_id).toBe(target.getID());
        expect(engine.inspect(relationship).properties.source_id).toBe(original.getID());
    });

    test("rejects stale generations, unowned updates and writes to managed identity properties", async () => {
        const engine = setup();
        const original = await add(engine);
        await expect(engine.apply(request("update", original.getID(), "Unlocked"))).rejects.toThrow(
            "locked by the current User",
        );
        const updated = await engine.apply(request("edit", original.getID(), "Changed"));
        await expect(
            engine.apply(request("edit", original.getID(), "Historical edit")),
        ).rejects.toThrow("single current generation");
        const invalid = request("edit", updated.getID(), "Invalid generation");
        invalid.setProperty("config_id", "DIFFERENT_CONFIG");
        await expect(engine.apply(invalid)).rejects.toThrow("managed by platform actions");
        expect(engine.storage.listItems("VersionedRecord")).toHaveLength(2);
        expect(
            engine.storage.getItem("VersionedRecord", updated.getID())?.properties.locked_by_id,
        ).toBeNull();
    });

    test("serverEvents=0 retains required version hooks and all edit lock hooks", async () => {
        const calls: string[] = [];
        const engine = setup({
            required: (item) => {
                calls.push("required");

                return item;
            },

            optional: (item) => {
                calls.push("optional");

                return item;
            },

            lock: (item) => {
                calls.push("lock");

                return item;
            },
        });
        bind(engine, "onBeforeVersion", "required", true);
        bind(engine, "onAfterVersion", "optional");
        bind(engine, "onBeforeLock", "lock");
        const original = await add(engine);
        const edit = request("edit", original.getID(), "Changed");
        edit.setAttribute("serverEvents", "0");
        expect((await engine.apply(edit)).node.properties.generation).toBe(2);
        expect(calls).toEqual(["lock", "required"]);
    });

    test("delete removes every generation atomically and rejects referenced history", async () => {
        const engine = setup();
        const original = await add(engine);
        const updated = await engine.apply(request("edit", original.getID(), "Changed"));
        const link = engine.seed("RecordLink", { related_id: original.getID() });
        const rejected = await engine.apply(request("delete", updated.getID()));
        expect(rejected.getErrorCode()).toBe("ReferencedItem");
        expect(engine.storage.listItems("VersionedRecord")).toHaveLength(2);
        await engine.apply(engine.item(link, "delete"));
        await engine.apply(request("delete", updated.getID()));
        expect(engine.storage.listItems("VersionedRecord")).toHaveLength(0);
    });
});

test("nested relationship edits address copied IDs and preserve historical relationship values", async () => {
    const engine = setup();
    const original = await add(engine);
    const related = await add(engine, "Related");
    const linkRequest = Item.create("RecordLink", "add");
    linkRequest.setProperty("source_id", original.getID());
    linkRequest.setProperty("related_id", related.getID());
    const link = await engine.apply(linkRequest);
    const edit = request("edit", original.getID(), "Next generation");
    const child = Item.create("RecordLink", "edit");
    child.setProperty("id", link.getID());
    child.setProperty("source_id", original.getID());
    child.setProperty("sort_order", 42);
    edit.addRelationship(child);

    const result = await engine.apply(edit);
    const query = Item.create("RecordLink", "get");
    query.setProperty("source_id", result.getID());
    const copied = (await engine.apply(query)).node;

    expect(result.getID()).not.toBe(original.getID());
    expect(copied?.attributes.id).not.toBe(link.getID());
    expect(copied?.properties).toMatchObject({ source_id: result.getID(), sort_order: 42 });
    const get = Item.create("RecordLink", "get");
    get.setProperty("id", link.getID());
    const stored = (await engine.apply(get)).node;
    expect(stored?.properties.source_id).toBe(original.getID());
    expect(stored?.properties.sort_order).not.toBe(42);
});
