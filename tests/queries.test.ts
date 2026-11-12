import { describe, expect, test } from "bun:test";

import { createHarness } from "../src/index.js";
import type { Item } from "../src/items/item.js";
import { queryProject } from "./helpers/queries.js";

function names(result: Item): string[] {
    return result.payload.items.map((item) => String(item.properties.name));
}

function query(criteria: string, attributes = ""): string {
    return `<Item type="QueryPart" action="get" orderBy="count" ${attributes}>${criteria}</Item>`;
}

describe("native AML queries", () => {
    test("preserves repeated criteria, logical precedence and nested NOT", async () => {
        await using project = await queryProject();
        using h = await createHarness({ cwd: project.cwd });
        const range = await h.applyAML(
            query('<count condition="gt">1</count><count condition="lt">4</count>'),
        );
        const grouped = await h.applyAML(
            query(`<or>
            <and><count condition="ge">2</count><count condition="le">3</count></and>
            <not><count condition="lt">4</count></not>
        </or>`),
        );

        expect(names(range)).toEqual(["Beta", "O'Neil"]);
        expect(names(grouped)).toEqual(["Beta", "O'Neil", "😀"]);
    });

    test("evaluates IN, BETWEEN, LIKE and SQL null logic without conflating empty text", async () => {
        await using project = await queryProject();
        using h = await createHarness({ cwd: project.cwd });
        const requests = [
            ["<name condition='in'>'Beta', 'O''Neil'</name>", ["Beta", "O'Neil"]],
            ["<count condition='between'>2 and 3</count>", ["Beta", "O'Neil"]],
            ["<count condition='not between'>2 and 3</count>", ["Alpha", "😀"]],
            ["<name condition='like'>_</name>", ["😀"]],
            ["<note condition='is null'/>", ["Alpha"]],
            ["<note></note>", ["Beta"]],
            ["<note condition='not in'>'UPPER', NULL</note>", []],
            ["<not><note>UPPER</note></not>", ["Beta", "😀"]],
            ["<note condition='not like'>%P%</note>", ["Beta", "😀"]],
        ] satisfies readonly (readonly [string, readonly string[]])[];

        for (const [criteria, expected] of requests) {
            expect(names(await h.applyAML(query(criteria)))).toEqual(expected);
        }
    });

    test("retains decimal and sub-millisecond date precision through SQLite selection", async () => {
        await using project = await queryProject();
        using h = await createHarness({ cwd: project.cwd });
        const exact = await h.applyAML(query("<price>9007199254740992.02</price>"));
        const larger = await h.applyAML(query('<price condition="gt">9007199254740992.01</price>'));
        const opposite = await h.applyAML(query("<not><price>9007199254740992.01</price></not>"));
        const date = await h.applyAML(
            query('<due condition="gt">2026-01-01T00:00:00.0000001</due>'),
        );

        expect(names(exact)).toEqual(["Beta"]);
        expect(names(larger)).toEqual(["Beta"]);
        expect(names(opposite)).toEqual(["Beta", "O'Neil", "😀"]);
        expect(names(date)).toEqual(["Beta", "O'Neil", "😀"]);
    });

    test("parses qualified literal-only WHERE and rejects executable SQL before any write", async () => {
        await using project = await queryProject();
        using h = await createHarness({ cwd: project.cwd });
        const result = await h.applyAML(
            query(
                "",
                `where="
            ([QueryPart].[count] BETWEEN 2 AND 3 OR name = '😀')
            AND NOT note IS NULL AND name NOT LIKE 'Z%'"`,
            ),
        );
        const quoted = await h.applyAML(query("", `where="name = 'O''Neil'"`));

        expect(names(result)).toEqual(["Beta", "O'Neil", "😀"]);
        expect(names(quoted)).toEqual(["O'Neil"]);

        for (const where of [
            "name = name",
            "count IN (SELECT count FROM QueryPart)",
            "count = 1; DELETE FROM QueryPart",
            "count = 1 -- ignored",
            "LOWER(name) = 'alpha'",
        ]) {
            await expect(
                h.applyAML(`<AML>
                <Item type="QueryPart" action="add"><name>Transient</name></Item>
                ${query("", `where="${where}"`)}
            </AML>`),
            ).rejects.toThrow();
            expect((await h.get("QueryPart", { name: "Transient" })).length).toBe(0);
        }
    });

    test("sorts before paging and preserves counts on empty pages", async () => {
        await using project = await queryProject();
        using h = await createHarness({ cwd: project.cwd });
        const page = await h.applyAML(`<Item type="QueryPart" action="get"
            orderBy="price desc, name asc" pagesize="1" page="2"/>`);
        const empty = await h.applyAML(query("", 'pagesize="2" page="8"'));
        const capped = await h.applyAML(query("", 'maxRecords="3" pagesize="2" page="2"'));

        expect(names(page)).toEqual(["Alpha"]);
        expect(page.payload.messages).toEqual([
            { name: "itemmax", value: "4" },
            { name: "pagemax", value: "4" },
        ]);
        expect(empty.getErrorCode()).toBe("0");
        expect(empty.payload.messages).toEqual([
            { name: "itemmax", value: "4" },
            { name: "pagemax", value: "2" },
        ]);
        expect(names(capped)).toEqual(["O'Neil"]);
    });

    test("resolves foreign properties and nested item selectors against imported metadata", async () => {
        await using project = await queryProject();
        using h = await createHarness({ cwd: project.cwd });
        const foreign = await h.applyAML(query("<parent_name>Alpha</parent_name>"));
        const nested = await h.applyAML(
            query(`<parent><Item type="QueryPart" action="get">
            <or><name>Alpha</name><name>Beta</name></or>
        </Item></parent>`),
        );

        expect(names(foreign)).toEqual(["Beta", "O'Neil"]);
        expect(names(nested)).toEqual(["Beta", "O'Neil", "😀"]);
        const invalid = query('<parent><Item type="Identity" action="get"/></parent>');
        await expect(h.applyAML(invalid)).rejects.toThrow("Invalid nested selector");
    });

    test("idlist scopes mutations and malformed selectors never become unfiltered writes", async () => {
        await using project = await queryProject();
        using h = await createHarness({ cwd: project.cwd });
        const alpha = await h.getOne("QueryPart", { name: "Alpha" });
        const beta = await h.getOne("QueryPart", { name: "Beta" });
        const ids = `${alpha.id.toLowerCase()},${beta.id}`;
        await h.applyAML(`<Item type="QueryPart" action="update" idlist="${ids}">
            <note>Updated</note></Item>`);

        expect((await h.get("QueryPart", { note: "Updated" })).length).toBe(2);
        expect((await h.applyAML(query("", 'idlist=""'))).payload.items.length).toBe(0);
        await expect(h.applyAML(query("", 'pagesize="0"'))).rejects.toThrow("positive");
        await expect(h.applyAML(query("", 'page="2"'))).rejects.toThrow("pagesize");
        await expect(h.applyAML(query('<unknown condition="ne">x</unknown>'))).rejects.toThrow(
            "Unknown selector",
        );
    });
});
