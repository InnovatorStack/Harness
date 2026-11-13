import { expect, test } from "bun:test";

import { Item } from "../src/items/item.js";
import { decodeBaseInput } from "../src/methods/csharp/base-input.js";
import { ManagedInput } from "../src/methods/csharp/context.js";
import { ManagedOrigins } from "../src/methods/csharp/origins.js";
import { requestDocument } from "../src/platform/events/input.js";

function inputFrames() {
    const selected = Item.create("Entry", "get");
    selected.setProperty("name", "Captured");
    const origins = new ManagedOrigins();
    const frame = origins.capture(selected.payload);
    const payload = {
        xml: '<Item type="Entry" action="get"><name>Captured</name></Item>',
        document: false,
        origins: frame,
        currentDocument:
            '<AML><!--Current--><Item type="Other" action="add"><name>Current</name></Item></AML>',
        currentOrigins: { scope: frame.scope, tokens: ["m1"] },
    };

    return { selected, origins, payload };
}

test.each([false, true])(
    "detached input cannot reuse current document origins, including identical data: %s",
    (identical) => {
        const { selected, origins, payload } = inputFrames();
        const currentDocument = identical ? payload.xml : payload.currentDocument;

        expect(() =>
            decodeBaseInput(
                { ...payload, currentDocument, currentOrigins: payload.origins },
                origins,
            ),
        ).toThrow("cannot share pending Item origins");
        expect(selected.getProperty("name")).toBe("Captured");
    },
);

test("current document origins must belong to the active Method invocation", () => {
    const { selected, origins, payload } = inputFrames();

    expect(() =>
        decodeBaseInput(
            { ...payload, currentOrigins: { scope: crypto.randomUUID(), tokens: ["m1"] } },
            origins,
        ),
    ).toThrow("another invocation");
    expect(selected.getProperty("name")).toBe("Captured");
});

test.each([
    { currentDocument: undefined },
    { currentDocument: 42 },
    { currentOrigins: undefined },
    { document: "true" },
])("malformed current document frames fail explicitly: %j", (override) => {
    const { selected, origins, payload } = inputFrames();

    expect(() => decodeBaseInput({ ...payload, ...override }, origins)).toThrow();
    expect(selected.getProperty("name")).toBe("Captured");
});

test("base input changes patch current data without replacing the captured request", () => {
    const { origins, payload } = inputFrames();
    const input = decodeBaseInput(payload, origins);
    const document = requestDocument(input.item);

    expect(input.change(origins)).toBeUndefined();
    document.setProperty("name", "Changed");
    const change = input.change(origins);

    expect(input.item.getProperty("name")).toBe("Captured");
    expect(change?.request).toBeUndefined();
    expect(change?.document).toBeUndefined();
    expect(change?.documentChange).toMatchObject({
        before: { properties: { name: "Current" } },
        after: { properties: { name: "Changed" } },
    });
    expect(change?.documentOrigins?.tokens).not.toEqual(change?.origins.tokens);
});

test("a later document reload stays independent of the already detached base request", () => {
    const { origins, payload } = inputFrames();
    const input = decodeBaseInput(payload, origins);
    const document = requestDocument(input.item);
    const managed = new ManagedInput(document, new ManagedOrigins());
    const retained = document.clone();
    retained.setProperty("name", "Detached current document");
    const replacement = Item.create("Replacement");
    replacement.setProperty("name", "Later document");
    managed.synchronize({
        kind: "result",
        context: replacement.payload,
        contextOrigins: { scope: managed.frame.scope, tokens: ["m1"] },
        contextDocument: '<Item type="Replacement"><name>Later document</name></Item>',
        documentReplaced: true,
        retainedContext: retained.payload,
        retainedOrigins: managed.frame,
    });
    const change = input.change(origins);

    expect(input.item.getProperty("name")).toBe("Captured");
    expect(change?.request).toBeUndefined();
    expect(change?.documentChange).toBeUndefined();
    expect(change?.document?.xml).toContain("Later document");
    expect(change?.retainedDocument).toMatchObject({
        after: { properties: { name: "Detached current document" } },
    });
    expect(change?.documentOrigins?.tokens).not.toEqual(change?.origins.tokens);
});
