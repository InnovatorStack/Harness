import { afterEach, describe, expect, test } from "bun:test";

import { createEngine } from "../src/engine.js";
import type { Engine } from "../src/engine.js";
import { Item } from "../src/items/item.js";
import type { MethodExecutor, MethodPorts } from "../src/methods/types.js";
import { importPackageDocuments } from "../src/packages/module.js";
import { parseAml } from "../src/packages/parser.js";

type Handler = (context: Item, ports: MethodPorts) => Item | Promise<Item>;

const worlds: Engine[] = [];
const packagePath = Bun.fileURLToPath(
    new URL("../.harness/packages/pipeline/Import/structure.xml", import.meta.url),
);

afterEach(() => {
    for (const world of worlds.splice(0)) {
        world.close();
    }
});

async function world(handlers: Readonly<Record<string, Handler>> = {}): Promise<Engine> {
    const executor: MethodExecutor = {
        language: "Conformance",

        async execute(method, context, ports) {
            const handler = handlers[method.name];

            if (!handler) {
                throw new Error(`Missing conformance executor handler '${method.name}'.`);
            }

            return await handler(context, ports);
        },
    };
    const harness = createEngine({ executors: [executor] });
    worlds.push(harness);
    await harness.loadPackages([packagePath]);

    return harness;
}

function method(name: string): string {
    return `<Item type="Method" action="add"><name>${name}</name><method_type>Conformance</method_type><method_code>unit-test executor port</method_code></Item>`;
}

function event(name: string, handler: string, order = 10, required = false): string {
    return `<Item type="Server Event" action="add"><source_id><Item type="ItemType" action="get"><name>TestNode</name></Item></source_id><related_id><Item type="Method" action="get"><name>${handler}</name></Item></related_id><server_event>${name}</server_event><sort_order>${order}</sort_order><is_required>${required ? "1" : "0"}</is_required><event_version>version_1</event_version></Item>`;
}

function importXml(harness: Engine, xml: string): void {
    harness.runtime.executeSync(importPackageDocuments, [
        parseAml(`<AML>${xml}</AML>`, "events.xml"),
    ]);
}

describe("schema-driven seeding", () => {
    test("generates identities and resolves record references without running business hooks", async () => {
        let calls = 0;
        const harness = await world({
            before: (context) => {
                calls++;

                return context;
            },
        });
        importXml(harness, method("before") + event("onBeforeAdd", "before"));
        const parent = harness.seed("TestNode", {
            name: "Parent",
            count: 0,
            note: "",
            optional: null,
        });
        const child = harness.seed("TestNode", { name: "Child", parent });
        expect(parent.id).toMatch(/^[A-F0-9]{32}$/);
        expect(harness.inspect(child).properties.parent).toBe(parent.id);
        expect(harness.inspect(parent).properties).toMatchObject({
            count: 0,
            note: "",
            optional: null,
        });
        expect(calls).toBe(0);
        expect(() => harness.seed("TestNode", {})).toThrow("Required property");
        expect(() => harness.seed("TestNode", { name: "Wrong", unknown: 0 })).toThrow(
            "Unknown property",
        );
        expect(harness.storage.listItems("TestNode")).toHaveLength(2);
    });

    test("rejects references from another world and invalidates references across reset", async () => {
        const first = await world();
        const second = await world();
        const reference = first.seed("TestNode", { name: "Parent" });
        expect(() => second.seed("TestNode", { name: "Child", parent: reference })).toThrow(
            "different world",
        );
        first.checkpoint();
        first.reset();
        expect(() => first.inspect(reference)).toThrow("before reset");
        expect(first.inspect(first.find("TestNode", { name: "Parent" })).properties.name).toBe(
            "Parent",
        );
    });
});

describe("action and event pipeline", () => {
    test("empty numeric AML values clear nullable fields while invalid numbers and missing required values still fail", async () => {
        const harness = await world();
        importXml(
            harness,
            `
      <Item type="Property" action="add"><source_id><Item type="ItemType" action="get"><name>TestNode</name></Item></source_id><name>ratio</name><data_type>float</data_type></Item>
      <Item type="Property" action="add"><source_id><Item type="ItemType" action="get"><name>TestNode</name></Item></source_id><name>enabled</name><data_type>boolean</data_type></Item>
      <Item type="Property" action="add"><source_id><Item type="ItemType" action="get"><name>TestNode</name></Item></source_id><name>amount</name><data_type>decimal</data_type></Item>
      <Item type="Property" action="add"><source_id><Item type="ItemType" action="get"><name>TestNode</name></Item></source_id><name>required_count</name><data_type>integer</data_type><is_required>1</is_required></Item>
    `,
        );
        const reference = harness.seed("TestNode", {
            name: "Original",
            count: 7,
            ratio: 1.25,
            enabled: 1,
            amount: "2.30",
            required_count: 1,
        });
        const edit = Item.create("TestNode", "edit");
        edit.setProperty("id", reference.id);

        for (const name of ["count", "ratio", "enabled", "amount", "note"]) {
            edit.setProperty(name, "");
        }

        await harness.apply(edit);
        expect(harness.inspect(reference).properties).toMatchObject({
            count: null,
            ratio: null,
            enabled: null,
            amount: null,
            note: "",
            required_count: 1,
        });

        const invalid = Item.create("TestNode", "edit");
        invalid.setProperty("id", reference.id);
        invalid.setProperty("name", "Must roll back");
        invalid.setProperty("count", "not-a-number");
        await expect(harness.apply(invalid)).rejects.toThrow("Invalid integer value");
        expect(harness.inspect(reference).properties.name).toBe("Original");

        const required = Item.create("TestNode", "edit");
        required.setProperty("id", reference.id);
        required.setProperty("required_count", "");
        await expect(harness.apply(required)).rejects.toThrow("Required property");
        expect(harness.inspect(reference).properties.required_count).toBe(1);
    });

    test("nested selects project related records without persisting the expansion", async () => {
        const harness = await world();
        const ancestor = harness.seed("TestNode", { name: "Ancestor" });
        const parent = harness.seed("TestNode", { name: "Parent", parent: ancestor });
        const link = harness.seed("TestLink", { source_id: parent, related_id: ancestor });
        const query = Item.create("TestLink", "get");
        query.setProperty("id", link.id);
        query.setAttribute("select", "id,source_id(name,parent(name)),related_id(name)");

        const result = await harness.apply(query);
        const expanded = result.getPropertyItem("source_id");
        expect(expanded?.getProperty("name")).toBe("Parent");
        expect(expanded?.getPropertyItem("parent")?.getProperty("name")).toBe("Ancestor");
        expect(result.getPropertyItem("related_id")?.getProperty("name")).toBe("Ancestor");
        expect(harness.inspect(link).properties.source_id).toBe(parent.id);

        query.setAttribute("select", "source_id(name");
        await expect(harness.apply(query)).rejects.toThrow("Invalid select");
    });

    test("after-get events populate federated response fields while federation filters fail explicitly", async () => {
        const harness = await world({
            populate: (context) => {
                for (let index = 0; index < context.getItemCount(); index += 1) {
                    context
                        .getItemByIndex(index)
                        .setProperty("computed", "Calculated by the get event");
                }

                return context;
            },
        });
        importXml(
            harness,
            `<Item type="Property" action="add"><source_id><Item type="ItemType" action="get"><name>TestNode</name></Item></source_id><name>computed</name><data_type>string</data_type><is_federated>1</is_federated></Item>${method(
                "populate",
            )}${event("onAfterGet", "populate")}`,
        );
        const reference = harness.seed("TestNode", { name: "Stored" });
        const result = await harness.apply(Item.create("TestNode", "get"));

        expect(result.getProperty("computed")).toBe("Calculated by the get event");
        expect(harness.inspect(reference).properties.computed).toBeUndefined();

        const filtered = Item.create("TestNode", "get");
        filtered.setProperty("computed", "Calculated by the get event");
        await expect(harness.apply(filtered)).rejects.toThrow("federation query support");
    });

    test("unsupported changes introduced by before events roll back their nested writes", async () => {
        const harness = await world({
            before: async (context, ports) => {
                const nested = Item.create("TestNode", "add");
                nested.setProperty("name", "Must roll back");
                await ports.apply(nested);
                context.setAttribute("page", "2");

                return context;
            },
        });
        importXml(harness, method("before") + event("onBeforeUpdate", "before"));
        const reference = harness.seed("TestNode", { name: "Original" });
        const edit = harness.item(reference, "update");
        edit.setProperty("name", "Changed");
        await expect(harness.apply(edit)).rejects.toThrow("attribute 'page'");
        expect(harness.inspect(reference).properties.name).toBe("Original");
        expect(harness.storage.listItems("TestNode")).toHaveLength(1);
        expect(harness.trace.filter((entry) => entry.kind === "mutation")).toMatchObject([
            { outcome: "rolledBack" },
        ]);
    });

    test("nested relationship additions execute while unsupported request forms fail instead of disappearing", async () => {
        const harness = await world();
        const target = harness.seed("TestNode", { name: "Target" });
        const add = Item.create("TestNode", "add");
        add.setProperty("name", "Parent");
        const child = Item.create("TestLink", "add");
        child.setProperty("related_id", target.id);
        add.addRelationship(child);
        const added = await harness.apply(add);
        expect(added.getRelationships("TestLink").getItemCount()).toBe(0);
        const query = Item.create("TestNode", "get");
        query.setProperty("id", added.getID());
        query.addRelationship(Item.create("TestLink", "get"));
        const fetched = await harness.apply(query);
        expect(fetched.getRelationships("TestLink").getItemCount()).toBe(1);
        expect(harness.storage.listItems("TestLink")).toMatchObject([
            { properties: { source_id: added.getID(), related_id: target.id } },
        ]);
        const update = Item.create("TestNode", "update");
        update.setProperty("id", added.getID());
        update.addRelationship(Item.create("TestLink", "delete"));
        await expect(harness.apply(update)).rejects.toThrow("one explicit relationship ID");
        update.setAction("get");
        await expect(harness.apply(update)).rejects.toThrow(
            "Nested get requires relationship gets",
        );
        expect(harness.storage.listItems("TestLink")).toHaveLength(1);
    });

    test("runtime definition mutations cannot diverge from the imported source catalog", async () => {
        const harness = await world({ original: (context) => context });
        importXml(harness, method("original"));
        const original = harness.find("Method", { name: "original" });
        const edit = harness.item(original, "update");
        edit.setProperty("method_code", "replacement body");
        await expect(harness.apply(edit)).rejects.toThrow("must be loaded through packages");
        expect(() => harness.seed("Method", { name: "seeded" })).toThrow(
            "must be loaded through packages",
        );
        expect(harness.inspect(original).properties.method_code).toBe("unit-test executor port");
        expect((await harness.callMethod("original", Item.create("TestNode"))).isError()).toBe(
            false,
        );
    });

    test("normal add runs imported hooks and normal deletion removes an unreferenced record", async () => {
        const calls: string[] = [];
        const harness = await world({
            before: (context) => {
                calls.push("before");
                context.setProperty("name", "From hook");

                return context;
            },

            after: (context) => {
                calls.push("after");
                expect(context.getID()).not.toBe("");

                return context;
            },
        });
        importXml(
            harness,
            method("before") +
                method("after") +
                event("onBeforeAdd", "before") +
                event("onAfterAdd", "after"),
        );
        const add = Item.create("TestNode", "add");
        add.setProperty("name", "Initial");
        expect((await harness.apply(add)).getProperty("name")).toBe("From hook");
        expect(calls).toEqual(["before", "after"]);
        const reference = harness.find("TestNode", { name: "From hook" });
        expect((await harness.apply(harness.item(reference, "delete"))).isError()).toBe(false);
        expect(harness.storage.listItems("TestNode")).toEqual([]);
    });

    test("ID-only event contexts hydrate without widening selected responses or allowing required fields to clear", async () => {
        const harness = await world({
            after: (context) => {
                expect(context.getProperty("name")).toBe("After");
                expect(context.getID()).not.toBe("");

                return context;
            },
        });
        importXml(harness, method("after") + event("onAfterUpdate", "after"));
        const reference = harness.seed("TestNode", { name: "Before" });
        const edit = harness.item(reference, "update");
        edit.setProperty("name", "After");
        edit.setAttribute("select", "id");
        const result = await harness.apply(edit);
        expect(result.getProperty("name")).toBe("");
        expect(harness.inspect(reference).properties.name).toBe("After");
        edit.setProperty("name", "");
        await expect(harness.apply(edit)).rejects.toThrow("Required property");
        expect(harness.inspect(reference).properties.name).toBe("After");
    });

    test("referenced deletions fail explicitly; single no-items AML preserves its error Item", async () => {
        const harness = await world();
        const result = await harness.applyAML('<Item type="TestNode" action="get" />');
        expect(result.isError()).toBe(true);
        expect(result.getErrorCode()).toBe("0");
        const parent = harness.seed("TestNode", { name: "Parent" });
        harness.seed("TestNode", { name: "Child", parent });
        const deletion = await harness.apply(harness.item(parent, "delete"));
        expect(deletion.getErrorCode()).toBe("ReferencedItem");
        expect(harness.inspect(parent).properties.name).toBe("Parent");
    });

    test("unknown event versions and ambiguous event orders cannot silently execute a different chain", async () => {
        const harness = await world({
            one: (context) => context,

            two: (context) => context,
        });
        importXml(
            harness,
            method("one") +
                method("two") +
                event("onBeforeGet", "one") +
                event("onBeforeGet", "two"),
        );
        await expect(harness.apply(Item.create("TestNode", "get"))).rejects.toThrow(
            "same sort order",
        );
        const versioned = await world({ one: (context) => context });
        importXml(
            versioned,
            method("one") + event("onBeforeGet", "one").replace("version_1", "version_2"),
        );
        await expect(versioned.apply(Item.create("TestNode", "get"))).rejects.toThrow(
            "not supported",
        );
        const suppressed = Item.create("TestNode", "get");
        suppressed.setAttribute("serverEvents", "0");
        expect((await versioned.apply(suppressed)).getErrorCode()).toBe("0");
    });
    test("before get modifies the request, after get modifies the response, in imported order", async () => {
        const calls: string[] = [];
        const harness = await world({
            first: (context) => {
                calls.push("first");
                context.setProperty("name", "Chosen");

                return context;
            },

            second: (context) => {
                calls.push("second");
                expect(context.getProperty("name")).toBe("Chosen");

                return context;
            },

            after: (context) => {
                calls.push("after");
                context.setProperty("note", "response only");

                return context;
            },
        });
        importXml(
            harness,
            method("first") +
                method("second") +
                method("after") +
                event("onBeforeGet", "second", 20) +
                event("onBeforeGet", "first", 10) +
                event("onAfterGet", "after"),
        );
        const chosen = harness.seed("TestNode", { name: "Chosen" });
        harness.seed("TestNode", { name: "Other" });
        const result = await harness.apply(Item.create("TestNode", "get"));
        expect(calls).toEqual(["first", "second", "after"]);
        expect(result.getItemCount()).toBe(1);
        expect(result.getProperty("note")).toBe("response only");
        expect(harness.inspect(chosen).properties.note).toBeUndefined();
        expect(
            harness.trace
                .filter((event) => event.kind === "event")
                .every((event) => event.outcome === "committed"),
        ).toBe(true);
    });

    test("onGet replacement suppresses both standard before and after hooks", async () => {
        const calls: string[] = [];
        const harness = await world({
            standard: (context) => {
                calls.push("standard");

                return context;
            },

            replacement: () => {
                calls.push("replacement");
                const result = Item.create("TestNode");
                result.setProperty("name", "Federated");

                return result;
            },
        });
        importXml(
            harness,
            method("standard") +
                method("replacement") +
                event("onBeforeGet", "standard") +
                event("onAfterGet", "standard") +
                event("onGet", "replacement"),
        );
        const result = await harness.apply(Item.create("TestNode", "get"));
        expect(result.getProperty("name")).toBe("Federated");
        expect(calls).toEqual(["replacement"]);
    });

    test("serverEvents=0 suppresses optional hooks while required hooks still run", async () => {
        const calls: string[] = [];
        const harness = await world({
            optional: (context) => {
                calls.push("optional");

                return context;
            },

            required: (context) => {
                calls.push("required");

                return context;
            },
        });
        importXml(
            harness,
            method("optional") +
                method("required") +
                event("onBeforeGet", "optional") +
                event("onBeforeGet", "required", 20, true),
        );
        harness.seed("TestNode", { name: "Node" });
        const query = Item.create("TestNode", "get");
        query.setAttribute("serverEvents", "0");
        await harness.apply(query);
        expect(calls).toEqual(["required"]);
    });

    test("nested mutations and parent updates roll back when an after event returns an error", async () => {
        let childId = "";
        const harness = await world({
            after: async (_context, ports) => {
                const edit = Item.create("TestNode", "update");
                edit.setAttribute("id", childId);
                edit.setAttribute("serverEvents", "0");
                edit.setProperty("note", "nested");
                await ports.apply(edit);

                return Item.error("Reject parent");
            },
        });
        importXml(harness, method("after") + event("onAfterUpdate", "after"));
        const parent = harness.seed("TestNode", { name: "Parent" });
        const child = harness.seed("TestNode", { name: "Child" });
        childId = child.id;
        const edit = harness.item(parent, "update");
        edit.setProperty("name", "Changed");
        const result = await harness.apply(edit);
        expect(result.isError()).toBe(true);
        expect(result.getErrorString()).toBe("Reject parent");
        expect(harness.inspect(parent).properties.name).toBe("Parent");
        expect(harness.inspect(child).properties.note).toBeUndefined();
        const mutations = harness.trace.filter((event) => event.kind === "mutation");
        expect(mutations).toHaveLength(2);
        expect(mutations.every((event) => event.outcome === "rolledBack")).toBe(true);
        expect(new Set(mutations.map((event) => event.requestId)).size).toBe(1);
    });

    test("a before error prevents mutation and unsupported capability failures cannot be swallowed", async () => {
        const harness = await world({
            before: () => Item.error("Stop"),

            unsupported: (_context, ports) => {
                try {
                    ports.fail("Missing capability");
                } catch {
                    // A caught capability error must still poison the owning request.
                }

                return Item.create("TestNode");
            },
        });
        importXml(
            harness,
            method("before") + method("unsupported") + event("onBeforeAdd", "before"),
        );
        const add = Item.create("TestNode", "add");
        add.setProperty("name", "Rejected");
        expect((await harness.apply(add)).isError()).toBe(true);
        expect(harness.storage.listItems("TestNode")).toEqual([]);
        await expect(harness.callMethod("unsupported", Item.create("TestNode"))).rejects.toThrow(
            "Missing capability",
        );
    });

    test("AML batches are atomic and queries support nested item selectors and ordering", async () => {
        const harness = await world();
        const parent = harness.seed("TestNode", { name: "Parent", count: 1 });
        harness.seed("TestNode", { name: "First", parent, count: 10 });
        harness.seed("TestNode", { name: "Second", parent, count: 20 });
        const query = Item.create("TestNode", "get");
        const parentQuery = Item.create("TestNode", "get");
        parentQuery.setProperty("name", "Parent");
        query.setPropertyItem("parent", parentQuery);
        query.setAttribute("orderBy", "count DESC");
        const result = await harness.apply(query);
        expect(result.getItemCount()).toBe(2);
        expect(result.getItemByIndex(0).getProperty("name")).toBe("Second");
        await expect(
            harness.applyAML(
                '<AML><Item type="TestNode" action="add"><name>Temporary</name></Item><Item type="TestNode" action="get" where="name like anything" /></AML>',
            ),
        ).rejects.toThrow("Unsupported where");
        expect(harness.storage.listItems("TestNode")).toHaveLength(3);
    });

    test("foreign values are projected and unchanged computed fields survive read/edit round trips", async () => {
        const harness = await world();
        const source = harness.seed("TestNode", { name: "Source" });
        const target = harness.seed("TestNode", { name: "Target" });
        const link = harness.seed("TestLink", {
            source_id: source,
            related_id: target,
        });
        const query = Item.create("TestLink", "get");
        query.setAttribute("id", link.id);
        const item = await harness.apply(query);
        expect(item.getProperty("source_name")).toBe("Source");
        expect(harness.find("TestLink", { source_name: "Source" }).id).toBe(link.id);
        item.setAction("edit");
        item.setProperty("note", "Changed");
        expect((await harness.apply(item)).isError()).toBe(false);
        expect(harness.inspect(link).properties.note).toBe("Changed");
        expect(harness.inspect(link).properties.source_name).toBeUndefined();
        item.setProperty("source_name", "Cannot overwrite source");
        await expect(harness.apply(item)).rejects.toThrow("computed");
    });

    test("selectors validate property names on empty worlds and reject unrelated where qualifiers", async () => {
        const harness = await world();
        expect(() => harness.find("TestNode", { missing: "Value" })).toThrow("Unknown selector");
        const reference = harness.seed("TestNode", { name: "Chosen" });
        const get = Item.create("TestNode", "get");
        get.setAttribute("where", "[TestNode].[name] = 'Chosen'");
        expect((await harness.apply(get)).getID()).toBe(reference.id);
        get.setAttribute("where", "[Unrelated].[name] = 'Chosen'");
        await expect(harness.apply(get)).rejects.toThrow("Where qualifier");
    });
});
