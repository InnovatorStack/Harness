import { expect, test } from "bun:test";

import { Item } from "../src/items/item.js";
import { ManagedInput } from "../src/methods/csharp/context.js";
import { documentInput, readDocument, rememberDocument } from "../src/methods/csharp/documents.js";
import { ManagedOrigins } from "../src/methods/csharp/origins.js";

test.each([
    { name: "nontext", xml: 42 },
    { name: "different value", xml: '<Item type="Record"><count>3</count></Item>' },
    { name: "different type", xml: '<Item type="Other"><count>2</count></Item>' },
    { name: "malformed", xml: '<Item type="Record">' },
])("$name document XML cannot mutate retained caller input", ({ xml }) => {
    const context = Item.create("Original");
    context.setProperty("name", "Unchanged");
    const original = context.node;
    const input = new ManagedInput(context, new ManagedOrigins());
    const changed = Item.create("Record");
    changed.setProperty("count", 2);

    expect(() =>
        input.synchronize({
            kind: "result",
            context: changed.payload,
            contextOrigins: { scope: input.frame.scope, tokens: ["m1"] },
            contextDocument: xml,
        }),
    ).toThrow();
    expect(context.node).toBe(original);
    expect(context.getProperty("name")).toBe("Unchanged");
    expect(documentInput(context)).toBeUndefined();
});

test("native document snapshots retain typed values and send only later property changes", () => {
    const context = Item.create("Original");
    const input = new ManagedInput(context, new ManagedOrigins());
    const changed = Item.create("Record");
    changed.setProperty("count", 2);
    changed.setProperty("empty", null);
    changed.setPropertyAttribute("empty", "is_null", "1");
    input.synchronize({
        kind: "result",
        context: changed.payload,
        contextOrigins: { scope: input.frame.scope, tokens: ["m1"] },
        contextDocument:
            '<AML><!--Native marker--><Item type="Record"><count>2</count><empty is_null="1" /></Item></AML>',
        documentReplaced: true,
    });

    expect(context.node.properties).toEqual({ count: 2, empty: null });
    expect(documentInput(context)?.change).toBeUndefined();
    context.setProperty("count", 3);
    const document = documentInput(context);

    expect(document?.xml).toContain("<!--Native marker-->");
    expect(document?.change).toMatchObject({
        before: { properties: { count: 2 } },
        after: { properties: { count: 3 } },
    });
    expect(document?.change?.after.properties).not.toHaveProperty("empty");
});

test("identical business data cannot hide a different document Item origin", () => {
    const item = Item.create("Record");
    item.setProperty("name", "Same");
    const origins = new ManagedOrigins();
    origins.capture(item.payload);
    rememberDocument(item, '<AML><Item type="Record"><name>Same</name></Item></AML>');
    const replacement = Item.create("Record");
    replacement.setProperty("name", "Same");
    item.payload.items = replacement.payload.items;

    expect(() => documentInput(item)).toThrow("qualified DOM replacement profile");
});

test("native scalar and fault document projections retain their response meaning", () => {
    expect(readDocument("<Result>Current scalar</Result>")).toEqual({
        items: [],
        result: "Current scalar",
    });
    const payload = readDocument(`<SOAP-ENV:Envelope
        xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">
        <SOAP-ENV:Body><SOAP-ENV:Fault><faultcode>0</faultcode>
        <faultstring>Current fault</faultstring></SOAP-ENV:Fault></SOAP-ENV:Body>
    </SOAP-ENV:Envelope>`);

    expect(payload).toEqual({ items: [], error: { code: "0", message: "Current fault" } });
});
