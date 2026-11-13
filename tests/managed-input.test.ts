import { expect, test } from "bun:test";

import { AmlLogicalOperator, Item } from "../src/items/item.js";
import { ManagedInput } from "../src/methods/csharp/context.js";
import { ManagedOrigins } from "../src/methods/csharp/origins.js";

function inputGraph() {
    const context = Item.create("Context");
    context.setProperty("name", "Original");
    const owner = Item.create("Identity");
    owner.setProperty("name", "Owner");
    context.setPropertyItem("owner", owner);
    const relationship = Item.create("Link");
    relationship.setProperty("name", "Relationship");
    context.addRelationship(relationship);
    const criteria = Item.create("Target");
    criteria.setProperty("name", "Criteria");
    context.node.logical = [
        {
            operator: AmlLogicalOperator.And,
            terms: [{ name: "target", attributes: {}, item: criteria.node }],
        },
    ];
    const origins = new ManagedOrigins();
    const input = new ManagedInput(context, origins);

    return { context, owner, relationship, criteria, input };
}

test.each(["result", "failure"])(
    "managed %s reconciles retained properties, relationships and logical Items independently of the document",
    (kind) => {
        const { context, owner, relationship, criteria, input } = inputGraph();
        const selected = new Item({ items: [context.node] });
        const retained = context.clone();
        retained.setProperty("name", "Detached root");
        retained.getPropertyItem("owner")?.setProperty("name", "Detached owner");
        retained.getRelationships().getItemByIndex(0).setProperty("name", "Detached relationship");
        const group = retained.node.logical?.[0];
        const term = group?.terms[0];

        if (!term || !("item" in term)) {
            throw new Error("The original logical Item must exist.");
        }

        term.item.properties.name = "Detached criteria";
        const document = Item.create("Replacement");
        document.setProperty("name", "Current document");
        input.synchronize({
            kind,
            context: document.payload,
            contextOrigins: { scope: input.frame.scope, tokens: ["m1"] },
            retainedContext: retained.payload,
            retainedOrigins: input.frame,
        });

        expect(context.getProperty("name")).toBe("Current document");
        expect(selected.getProperty("name")).toBe("Detached root");
        expect(selected.getPropertyItem("owner")?.node).toBe(owner.node);
        expect(selected.getRelationships().getItemByIndex(0).node).toBe(relationship.node);
        expect(owner.getProperty("name")).toBe("Detached owner");
        expect(relationship.getProperty("name")).toBe("Detached relationship");
        expect(criteria.getProperty("name")).toBe("Detached criteria");
    },
);

test("a retained frame cannot replace the original selected input", () => {
    const { context, owner, input } = inputGraph();
    const original = context.node;
    const replacement = Item.create("Replacement");
    replacement.setProperty("name", "Must not propagate");
    const frame = { scope: input.frame.scope, tokens: ["m1"] };

    expect(() =>
        input.synchronize({
            kind: "result",
            context: replacement.payload,
            contextOrigins: frame,
            retainedContext: replacement.payload,
            retainedOrigins: frame,
        }),
    ).toThrow("preserve its original selected Item identities");
    expect(context.node).toBe(original);
    expect(context.getProperty("name")).toBe("Original");
    expect(owner.getProperty("name")).toBe("Owner");
});

test("conflicting document and retained projections reject before changing caller objects", () => {
    const { context, owner, input } = inputGraph();
    const original = context.node;
    const document = context.clone();
    const retained = context.clone();
    document.setProperty("name", "Document value");
    retained.setProperty("name", "Conflicting value");

    expect(() =>
        input.synchronize({
            kind: "result",
            context: document.payload,
            contextOrigins: input.frame,
            retainedContext: retained.payload,
            retainedOrigins: input.frame,
        }),
    ).toThrow("disagree about the same Item");
    expect(context.node).toBe(original);
    expect(context.getProperty("name")).toBe("Original");
    expect(owner.getProperty("name")).toBe("Owner");
});

test("identical business data cannot hide conflicting child identities across projections", () => {
    const context = Item.create("Context");
    context.setPropertyItem("owner", Item.create("Identity"));
    const input = new ManagedInput(context, new ManagedOrigins());
    const document = context.clone();
    const retained = context.clone();

    expect(() =>
        input.synchronize({
            kind: "result",
            context: document.payload,
            contextOrigins: { scope: input.frame.scope, tokens: ["b1", "m1"] },
            retainedContext: retained.payload,
            retainedOrigins: input.frame,
        }),
    ).toThrow("disagree about the same Item");
    expect(context.getPropertyItem("owner")?.node).toBeDefined();
});
