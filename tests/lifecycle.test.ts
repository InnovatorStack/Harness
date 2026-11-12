import { afterEach, describe, expect, test } from "bun:test";

import { createEngine } from "../src/engine.js";
import type { Engine } from "../src/engine.js";
import { Item } from "../src/items/item.js";
import type { MethodExecutor, MethodPorts } from "../src/methods/types.js";
import { importPackageDocuments } from "../src/packages/module.js";
import { parseAml } from "../src/packages/parser.js";

type Handler = (item: Item, ports: MethodPorts) => Item | Promise<Item>;

const worlds: Engine[] = [];

afterEach(() => {
    for (const world of worlds.splice(0)) {
        world.close();
    }
});

function load(engine: Engine, xml: string): void {
    engine.runtime.executeSync(importPackageDocuments, [
        parseAml(`<AML>${xml}</AML>`, "lifecycle.xml"),
    ]);
}

function setup(handlers: Readonly<Record<string, Handler>> = {}): Engine {
    const executor: MethodExecutor = {
        language: "Conformance",

        async execute(method, item, ports) {
            const handler = handlers[method.name];

            if (!handler) {
                throw new Error(`Missing lifecycle test handler '${method.name}'.`);
            }

            return await handler(item, ports);
        },
    };
    const engine = createEngine({
        executors: [executor],

        userId: () => "TEST_USER",
    });
    worlds.push(engine);
    load(
        engine,
        `
    <Item type="ItemType" action="add" id="DOCUMENT_TYPE">
      <name>TestDocument</name><is_versionable>1</is_versionable>
      <Relationships><Item type="Property" action="add"><name>name</name><data_type>string</data_type></Item></Relationships>
    </Item>
    <Item type="Life Cycle Map" action="add" id="DOCUMENT_CYCLE">
      <name>Document</name><start_state>DRAFT_STATE</start_state>
      <Relationships>
        <Item type="Life Cycle State" action="add" id="DRAFT_STATE"><name>Draft</name></Item>
        <Item type="Life Cycle State" action="add" id="REVIEW_STATE"><name>Review</name></Item>
        <Item type="Life Cycle State" action="add" id="RELEASED_STATE"><name>Released</name><set_is_released>1</set_is_released><set_not_lockable>1</set_not_lockable></Item>
        <Item type="Life Cycle Transition" action="add" id="SEND_TO_REVIEW"><from_state>DRAFT_STATE</from_state><to_state>REVIEW_STATE</to_state></Item>
        <Item type="Life Cycle Transition" action="add" id="RELEASE_DOCUMENT"><from_state>REVIEW_STATE</from_state><to_state>RELEASED_STATE</to_state></Item>
      </Relationships>
    </Item>
    <Item type="ItemType Life Cycle" action="add"><source_id>DOCUMENT_TYPE</source_id><related_id>DOCUMENT_CYCLE</related_id></Item>
  `,
    );

    return engine;
}

function bind(engine: Engine, name: string, handler: string): void {
    load(
        engine,
        `
    <Item type="Method" action="add" id="METHOD_${handler}"><name>${handler}</name><method_type>Conformance</method_type><method_code>test executor</method_code></Item>
    <Item type="Server Event" action="add"><source_id>DOCUMENT_TYPE</source_id><related_id>METHOD_${handler}</related_id><server_event>${name}</server_event><sort_order>10</sort_order></Item>
  `,
    );
}

async function add(engine: Engine): Promise<Item> {
    const request = Item.create("TestDocument", "add");
    request.setProperty("name", "Document");

    return await engine.apply(request);
}

function promote(id: string, state: string): Item {
    const request = Item.create("TestDocument", "promoteItem");
    request.setProperty("id", id);
    request.setProperty("state", state);

    return request;
}

describe("imported lifecycles", () => {
    test("add uses the map's start state and promote follows its transitions without creating a generation", async () => {
        const engine = setup();
        const original = await add(engine);
        expect(original.node.properties).toMatchObject({
            state: "Draft",
            current_state: "DRAFT_STATE",
            generation: 1,
        });
        const review = await engine.apply(promote(original.getID(), "Review"));
        expect(review.getID()).toBe(original.getID());
        expect(review.node.properties).toMatchObject({
            state: "Review",
            current_state: "REVIEW_STATE",
            generation: 1,
        });
        const released = await engine.apply(promote(original.getID(), "Released"));
        expect(released.node.properties).toMatchObject({
            state: "Released",
            is_released: 1,
            not_lockable: 1,
        });
        expect(engine.storage.listItems("TestDocument")).toHaveLength(1);
    });

    test("invalid transitions cannot change the persisted state", async () => {
        const engine = setup();
        const original = await add(engine);
        await expect(engine.apply(promote(original.getID(), "Released"))).rejects.toThrow(
            "Expected one transition",
        );
        expect(engine.storage.getItem("TestDocument", original.getID())?.properties.state).toBe(
            "Draft",
        );
    });

    test("runs imported before, pre, after and transactional post Methods in order", async () => {
        const calls: string[] = [];
        const handlers: Record<string, Handler> = {};

        for (const name of ["before", "pre", "after", "post"]) {
            handlers[name] = (item) => {
                calls.push(name);
                expect(item.getProperty("state")).toBe(
                    ["before", "pre"].includes(name) ? "Draft" : "Review",
                );

                return item;
            };
        }

        const engine = setup(handlers);
        bind(engine, "onBeforePromote", "before");
        bind(engine, "onAfterPromote", "after");

        for (const name of ["pre", "post"]) {
            load(
                engine,
                `<Item type="Method" action="add" id="METHOD_${name}"><name>${name}</name><method_type>Conformance</method_type><method_code>test executor</method_code></Item>`,
            );
        }

        load(
            engine,
            '<Item type="Life Cycle Transition" action="edit" id="SEND_TO_REVIEW"><pre_action>METHOD_pre</pre_action><post_action>METHOD_post</post_action><execute_post_in_main_txn>1</execute_post_in_main_txn></Item>',
        );
        const original = await add(engine);
        await engine.apply(promote(original.getID(), "Review"));
        expect(calls).toEqual(["before", "pre", "after", "post"]);
    });

    test("a rejected promotion rolls back the preceding versionable edit in the same Method transaction", async () => {
        const engine = setup({
            reject: () => Item.error("Review is forbidden"),

            submit: async (item, ports) => {
                const edit = Item.create("TestDocument", "edit");
                edit.setProperty("id", item.getID());
                edit.setProperty("name", "New name");
                const changed = await ports.apply(edit);

                return await ports.apply(promote(changed.getID(), "Review"));
            },
        });
        bind(engine, "onAfterPromote", "reject");
        load(
            engine,
            '<Item type="Method" action="add"><name>submit</name><method_type>Conformance</method_type><method_code>test executor</method_code></Item>',
        );
        const original = await add(engine);
        const result = await engine.callMethod("submit", original);
        expect(result.getErrorString()).toBe("Review is forbidden");
        expect(engine.storage.listItems("TestDocument")).toHaveLength(1);
        expect(engine.storage.getItem("TestDocument", original.getID())?.properties).toMatchObject({
            name: "Document",
            generation: 1,
            is_current: 1,
            state: "Draft",
        });
    });

    test("transition roles require an explicit authorization policy", async () => {
        const engine = setup();
        load(
            engine,
            '<Item type="Life Cycle Transition" action="edit" id="SEND_TO_REVIEW"><role><Item type="Identity" action="get"><name>World</name></Item></role></Item>',
        );
        const original = await add(engine);
        await expect(engine.apply(promote(original.getID(), "Review"))).rejects.toThrow(
            "Authorization rules exist",
        );
        expect(engine.storage.getItem("TestDocument", original.getID())?.properties.state).toBe(
            "Draft",
        );
    });

    test("outside-transaction post Methods fail before mutation instead of acquiring incorrect rollback semantics", async () => {
        const engine = setup();
        load(
            engine,
            `<Item type="Method" action="add" id="SOME_METHOD"><name>Post transition</name><method_type>Conformance</method_type><method_code>test executor</method_code></Item>
      <Item type="Life Cycle Transition" action="edit" id="SEND_TO_REVIEW"><post_action>SOME_METHOD</post_action><execute_post_in_main_txn>0</execute_post_in_main_txn></Item>`,
        );
        const original = await add(engine);
        await expect(engine.apply(promote(original.getID(), "Review"))).rejects.toThrow(
            "outside the main transaction",
        );
        expect(engine.storage.getItem("TestDocument", original.getID())?.properties.state).toBe(
            "Draft",
        );
    });
});

test("seeding resolves lifecycle defaults and named states without copied state IDs", () => {
    const engine = setup();
    const draft = engine.inspect(engine.seed("TestDocument", { name: "Initial" }));
    const review = engine.inspect(
        engine.seed("TestDocument", { name: "Review fixture", state: "Review" }),
    );
    expect(draft.properties).toMatchObject({ state: "Draft", current_state: "DRAFT_STATE" });
    expect(review.properties).toMatchObject({ state: "Review", current_state: "REVIEW_STATE" });
    expect(engine.trace.filter((entry) => entry.kind === "method")).toEqual([]);
    expect(() =>
        engine.seed("TestDocument", {
            name: "Invalid",
            state: "Review",
            current_state: "DRAFT_STATE",
        }),
    ).toThrow("must agree");
    expect(engine.storage.listItems("TestDocument")).toHaveLength(2);
});
