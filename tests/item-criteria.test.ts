import { expect, test } from "bun:test";

import { decodePayload } from "../src/items/codec.js";
import { Item, itemNode } from "../src/items/item.js";
import { parseItems } from "../src/items/xml.js";

function parse(xml: string): Item {
    const result = parseItems(xml)[0];

    if (!result) {
        throw new Error("Expected an AML query.");
    }

    return result;
}

test("logical criteria, nested selectors and response messages survive validated transport", () => {
    const item = parse(`<Item type="Part" action="get"><name>First</name>
        <name condition="ne">Excluded</name><or><count condition="gt">1</count>
            <parent><Item type="Part" action="get"><name>Parent</name></Item></parent>
        </or><not><note is_null="1"/></not>
    </Item>`);
    item.payload.messages = [{ name: "itemmax", value: "2" }];
    const encoded = JSON.stringify(item.payload);
    const wire: unknown = JSON.parse(encoded);
    const decoded = decodePayload(wire);

    expect(decoded).toEqual(item.payload);
    expect(new Item(decoded).clone().payload).toEqual(decoded);
    expect(item.node.logical?.[0]).toMatchObject({
        operator: "and",
        implicit: true,
        terms: [{ name: "name", value: "Excluded", attributes: { condition: "ne" } }],
    });
});

test("an ID attribute and ID property both survive as independent criteria", () => {
    const item = parse('<Item type="Part" action="get" id="FIRST"><id>SECOND</id></Item>');

    expect(item.getID()).toBe("FIRST");
    expect(item.node.logical?.[0]?.terms).toEqual([
        { name: "id", attributes: {}, value: "SECOND" },
    ]);
});

test("optional query fields leave ordinary Item payloads unchanged", () => {
    const node = itemNode("Part", "get");
    const decoded = decodePayload({ items: [node] });

    expect(decoded).toEqual({ items: [node] });
    expect(decoded).not.toHaveProperty("messages");
    expect(decoded.items[0]).not.toHaveProperty("logical");
});

test("logical transport rejects malformed operators, implicit groups and value shapes", () => {
    for (const logical of [
        [{ operator: "xor", terms: [] }],
        [{ operator: "or", terms: [], implicit: true }],
        [{ operator: "and", terms: [{ name: "name", attributes: {}, value: {} }] }],
        [{ name: "name", attributes: {}, value: "x" }],
    ]) {
        expect(() => decodePayload({ items: [{ ...itemNode("Part"), logical }] })).toThrow();
    }

    expect(() => decodePayload({ items: [], messages: [{ name: "itemmax", value: 1 }] })).toThrow(
        "Invalid Item message",
    );
});

test("unsupported logical markup and repeated relationship containers never disappear silently", () => {
    for (const xml of [
        '<Item type="Part"><or select="name"><name>x</name></or></Item>',
        '<Item type="Part"><and>text<name>x</name></and></Item>',
        '<Item type="Part"><Relationships/><Relationships/></Item>',
        '<Item type="Part"><Relationships>text</Relationships></Item>',
    ]) {
        expect(() => parse(xml)).toThrow();
    }
});
