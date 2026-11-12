import { describe, expect, test } from "bun:test";

import { AmlParseError, parseAml } from "../src/packages/parser.js";

describe("parseAml", () => {
    test("preserves source text, attributes, CDATA, entities, and sibling order", () => {
        const xml = `<?xml version="1.0"?>
<AML>
  <!-- original redistributable fixture -->
  <Item type="Method" id="METHOD" action="add">
    <name>Run &amp; inspect</name>
    <method_code><![CDATA[  if (value < 1) {\r\n  return "<&>";\r\n}  ]]></method_code>
    <custom xml:lang="en"> A &#x26; B </custom>
  </Item>
  <Item type="SQL" id="QUERY"><name>Query</name></Item>
</AML>`;
        const document = parseAml(xml, "methods.xml");
        expect(document.xml).toBe(xml);
        expect(document.sha256).toBe(new Bun.CryptoHasher("sha256").update(xml).digest("hex"));
        expect(document.items.map((item) => item.attributes.type)).toEqual(["Method", "SQL"]);
        const first = document.items[0];
        expect(first?.attributes).toEqual({
            type: "Method",
            id: "METHOD",
            action: "add",
        });
        const properties = first?.children.filter((child) => child.kind === "element");
        expect(properties?.map((property) => property.name)).toEqual([
            "name",
            "method_code",
            "custom",
        ]);
        expect(properties?.[0]?.children).toEqual([{ kind: "text", value: "Run & inspect" }]);
        expect(properties?.[1]?.children).toEqual([
            { kind: "cdata", value: '  if (value < 1) {\r\n  return "<&>";\r\n}  ' },
        ]);
        expect(properties?.[2]?.attributes).toEqual({ "xml:lang": "en" });
        expect(properties?.[2]?.children).toEqual([{ kind: "text", value: " A & B " }]);
        expect(Object.isFrozen(document.items)).toBe(true);
        expect(Object.isFrozen(first?.attributes)).toBe(true);
    });

    test("records opening positions and indexed paths for nested items", () => {
        const document = parseAml(
            '<AML>\r\n  <Item\r\n type="ItemType" id="TYPE">\r\n    <name>Widget</name>\r\n    <Relationships>\r\n      <Item type="Property"><name>first</name></Item>\r\n      <Item type="Property"><name>second</name></Item>\r\n    </Relationships>\r\n  </Item>\r\n</AML>',
            "schema.xml",
        );
        const item = document.items[0];
        expect(item?.source).toEqual({
            file: "schema.xml",
            line: 2,
            column: 3,
            path: "/AML[1]/Item[1]",
        });
        const relationships = item?.children.find(
            (child) => child.kind === "element" && child.name === "Relationships",
        );
        expect(relationships?.kind).toBe("element");

        if (relationships?.kind !== "element") {
            throw new Error("Expected relationships");
        }

        const nested = relationships.children.filter((child) => child.kind === "element");
        expect(nested[1]?.source).toEqual({
            file: "schema.xml",
            line: 7,
            column: 7,
            path: "/AML[1]/Item[1]/Relationships[1]/Item[2]",
        });
    });

    test("accepts a sole Item root and preserves namespaced property markup", () => {
        const document = parseAml(
            '<Item type="Form" xmlns:ui="urn:ui"><body><ui:panel ui:label="Title" /></body></Item>',
            "form.xml",
        );
        expect(document.items[0]?.source.path).toBe("/Item[1]");
        const body = document.items[0]?.children[0];

        if (body?.kind !== "element") {
            throw new Error("Expected body");
        }

        expect(body.children[0]).toMatchObject({
            kind: "element",
            name: "ui:panel",
            attributes: { "ui:label": "Title" },
        });
    });

    test.each([
        ['<AML><Item type="X"></AML>', "InvalidXml"],
        ["<AML><Item /></AML>", "MissingItemType"],
        ['<AML><Item type=" " /></AML>', "MissingItemType"],
        ["<Result />", "UnsupportedRoot"],
        ["<AML><Method /></AML>", "UnsupportedAmlElement"],
        ["<AML>unexpected text</AML>", "UnsupportedAmlText"],
        ["<!DOCTYPE AML [<!ENTITY x 'expanded'>]><AML />", "UnsupportedDoctype"],
        ['<AML><Item type="X"><name>&nbsp;</name></Item></AML>', "InvalidXml"],
        ['<AML><Item type="X" type="Y" /></AML>', "DuplicateAttribute"],
        [
            '<AML xmlns:a="urn:x" xmlns:b="urn:x"><Item type="X" a:v="1" b:v="2" /></AML>',
            "DuplicateAttribute",
        ],
        ["<?apply something?><AML />", "UnsupportedProcessingInstruction"],
        ["<AML /><AML />", "InvalidXml"],
        ['<AML><Item type="X"><name>\u0000</name></Item></AML>', "InvalidXml"],
        ['<AML><?xml version="1.0"?></AML>', "InvalidXmlDeclaration"],
        ["<?xml nonsense?><AML />", "InvalidXmlDeclaration"],
    ])("rejects unsupported or malformed XML: %s", (xml, code) => {
        try {
            parseAml(xml, "broken.xml");

            throw new Error("Expected parsing to fail");
        } catch (error) {
            expect(error).toBeInstanceOf(AmlParseError);

            if (!(error instanceof AmlParseError)) {
                throw error;
            }

            expect(error.code).toBe(code);
            expect(error.source.file).toBe("broken.xml");
            expect(error.source.line).toBeGreaterThan(0);
            expect(error.source.column).toBeGreaterThan(0);
            expect(error.message).toContain("broken.xml:");
        }
    });
});
