import { expect, test } from "bun:test";

import { dataNodesMax } from "../src/core/limits.js";
import { Item } from "../src/items/item.js";
import { AmlLogicalOperator } from "../src/items/logical.js";
import { bindItemOrigin, itemNodes, itemOrigin } from "../src/items/origins.js";
import { parseItems } from "../src/items/xml.js";
import { ManagedOrigins } from "../src/methods/csharp/origins.js";
import { relationshipOrder } from "../src/methods/csharp/relationship-order.js";

test("Item cloning retains private origins through logical, property and relationship paths", () => {
    const input = Item.create("Root");
    input.setPropertyItem("z", Item.create("Z"));
    input.setPropertyItem("a", Item.create("A"));
    input.addRelationship(Item.create("Link"));
    input.node.logical = [
        {
            operator: AmlLogicalOperator.Or,
            terms: [{ name: "reference", attributes: {}, item: Item.create("Criterion").node }],
        },
    ];
    const nodes = [...itemNodes(input.payload)];

    expect(nodes.map((node) => node.type)).toEqual(["Root", "Criterion", "A", "Z", "Link"]);

    for (const node of nodes) {
        bindItemOrigin(node, Symbol("test Item"));
    }

    const json = JSON.stringify(input.payload);
    const copy = input.clone();
    const copied = [...itemNodes(copy.payload)];

    expect(copied.map(itemOrigin)).toEqual(nodes.map(itemOrigin));
    expect(copied.every((node, index) => node !== nodes[index])).toBe(true);
    expect(JSON.stringify(copy.payload)).toBe(json);
    expect(Object.getOwnPropertySymbols(copy.node)).toEqual([]);
    copy.node.relationships.length = 0;
    expect(input.node.relationships).toHaveLength(1);
});

test("managed origins are invocation-local and can follow a cloned pending request", () => {
    const first = new ManagedOrigins();
    const second = new ManagedOrigins();
    const input = Item.create("Root");
    const tokens = first.capture(input.payload);
    const other = second.capture(Item.create("Other root").payload);
    const copy = first.decode(input.payload, tokens);

    expect(tokens.tokens).toEqual(other.tokens);
    expect(tokens.scope).not.toBe(other.scope);
    expect(itemOrigin(new Item(copy).node)).toBe(itemOrigin(input.node));
    expect(() => second.decode(input.payload, tokens)).toThrow("another invocation");
    const fresh = second.decode(input.payload, { ...other, tokens: ["m1"] });
    expect(itemOrigin(new Item(fresh).node)).not.toBe(itemOrigin(input.node));
    expect(first.capture(new Item(copy).clone().payload)).toEqual(tokens);
    expect(first.capture(fresh)).toEqual({ ...tokens, tokens: ["b2"] });
});

const invalidTokens: readonly unknown[] = [
    undefined,
    [],
    ["b2"],
    ["m0"],
    ["m01"],
    ["m1000001"],
    ["m1 "],
    [12],
    ["m1", "m2"],
];

test.each(invalidTokens.map((tokens) => ({ tokens })))(
    "managed origins reject invalid or mismatched tokens: %j",
    ({ tokens }) => {
        const origins = new ManagedOrigins();
        const input = Item.create("Root");
        const frame = origins.capture(input.payload);

        expect(() => origins.decode(input.payload, { ...frame, tokens })).toThrow();
    },
);

test("duplicate origins fail instead of assigning one identity to different pending nodes", () => {
    const input = Item.create("Root");
    const first = Item.create("Link", "edit");
    first.setProperty("id", "same");
    const second = first.clone();
    second.setProperty("value", "Different");
    input.addRelationship(first);
    input.addRelationship(second);
    const origins = new ManagedOrigins();
    const frame = origins.capture(input.payload);

    expect(() => origins.decode(input.payload, { ...frame, tokens: ["m1", "m2", "m2"] })).toThrow(
        "duplicated",
    );
    bindItemOrigin(first.node, Symbol("shared origin"));
    input.node.relationships = [first.node, first.clone().node];
    expect(() => origins.capture(input.payload)).toThrow("more than once");
});

test("untracked edits retain their explicit missing-identity diagnostic", () => {
    const input = Item.create("Link", "edit");
    input.setProperty("id", "same");
    input.setProperty("value", "Original");
    const changed = input.clone();
    changed.setProperty("value", "Changed");

    expect(() => relationshipOrder([input.node, input.clone().node], [changed.node])).toThrow(
        "native node identity",
    );
});

test("origin traversal rejects excessive roots and cycles without exhausting its work stack", () => {
    const tooMany = Item.create("Root").payload;
    tooMany.items.length = dataNodesMax + 1;

    expect(() => [...itemNodes(tooMany)]).toThrow("root limit");
    const input = Item.create("Cycle");
    input.addRelationship(input);

    expect(() => [...itemNodes(input.payload)]).toThrow("nesting limit");
});

test("wire-origin capture does not invoke accessors while validating its input", () => {
    const input = Item.create("Root");
    let invoked = false;
    Object.defineProperty(input.node, "logical", {
        enumerable: true,

        get() {
            invoked = true;

            return [];
        },
    });

    expect(() => new ManagedOrigins().capture(input.payload)).toThrow();
    expect(invoked).toBe(false);
});

test("origin metadata never becomes business AML when a pending Item is encoded again", () => {
    const item = parseItems('<Item type="Root"><name>Value</name></Item>')[0];

    if (!item) {
        throw new Error("The original test request must contain one Item.");
    }

    item.setProperty("origin", "Business data");
    const input = JSON.stringify(item.payload);
    new ManagedOrigins().capture(item.payload);

    expect(JSON.stringify(item.payload)).toBe(input);
    expect(item.node.attributes).toEqual({});
    expect(item.node.properties).toEqual({ name: "Value", origin: "Business data" });
});
