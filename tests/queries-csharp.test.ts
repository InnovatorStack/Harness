import { expect, test } from "bun:test";

import { createHarness } from "../src/index.js";
import { Item } from "../src/items/item.js";
import { parseItems } from "../src/items/xml.js";
import { queryMethod, queryProject } from "./helpers/queries.js";

test("original C# query source retains groups, repeated criteria and paging metadata", async () => {
    await using project = await queryProject(
        queryMethod(
            "RunQuery",
            `
        Item request = this.newItem();
        request.loadAML("<Item type='QueryPart' action='get' orderBy='count' pagesize='1' page='2'><or><count condition='gt'>1</count><name>Alpha</name></or><count condition='ge'>1</count><count condition='le'>3</count></Item>");
        Item result = request.apply();
        if (result.isError()) return result;
        var itemmax = result.node.OwnerDocument.SelectSingleNode("//Message/event[@name='itemmax']/@value");
        var pagemax = result.node.OwnerDocument.SelectSingleNode("//Message/event[@name='pagemax']/@value");
        if (itemmax?.Value != "3" || pagemax?.Value != "3") throw new Exception("Paging metadata missing");
        if (result.getProperty("name") != "Beta") throw new Exception("Wrong query result");
        return result;
    `,
        ),
    );
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const result = await h.callMethod("RunQuery", Item.create("Context"));

    expect(result.getProperty("name")).toBe("Beta");
    expect(result.payload.messages).toEqual([
        { name: "itemmax", value: "3" },
        { name: "pagemax", value: "3" },
    ]);
}, 60_000);

test("TypeScript logical payloads survive a live C# XML edit and return to native execution", async () => {
    await using project = await queryProject(
        queryMethod(
            "EditQuery",
            `
        var criterion = this.node.SelectSingleNode("or/count");
        criterion.InnerText = "2";
        var repeated = this.node.SelectNodes("count");
        if (repeated.Count != 2) throw new Exception("Repeated criteria lost");
        return this.apply();
    `,
        ),
    );
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const context = parseItems(`<Item type="QueryPart" action="get" orderBy="count">
        <or><count>1</count><name>😀</name></or>
        <count condition="ge">1</count><count condition="le">3</count>
    </Item>`)[0];

    if (!context) {
        throw new Error("Expected the query context.");
    }

    const result = await h.callMethod("EditQuery", context);

    expect(result.getItemCount()).toBe(1);
    expect(result.getProperty("name")).toBe("Beta");
}, 60_000);

test("multi-item mutation hooks receive each concrete ID in deterministic action order", async () => {
    const before = queryMethod(
        "BeforeBulk",
        `
        if (this.getID() == "") throw new Exception("Missing mutation target");
        this.setProperty("note", "Before:" + this.getID());
        return this;
    `,
    );
    const after = queryMethod(
        "AfterBulk",
        `
        if (this.getProperty("name") == "Beta") return this.getInnovator().newError("Reject second");
        return this;
    `,
    );
    await using project = await queryProject(`${before}${after}
        <Item type="Server Event" action="add"><source_id>QUERY_PART</source_id>
            <related_id>QUERY_BeforeBulk</related_id><server_event>onBeforeUpdate</server_event>
        </Item>
        <Item type="Server Event" action="add"><source_id>QUERY_PART</source_id>
            <related_id>QUERY_AfterBulk</related_id><server_event>onAfterUpdate</server_event>
        </Item>`);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const result = await h.applyAML(`<Item type="QueryPart" action="update"
        where="count &lt;= 2"><note>Requested</note></Item>`);

    expect(result.isError()).toBe(true);
    expect(result.getErrorString()).toContain("Reject second");
    expect((await h.getOne("QueryPart", { name: "Alpha" })).properties.note).toBeNull();
    expect((await h.getOne("QueryPart", { name: "Beta" })).properties.note).toBe("");
}, 60_000);
