import { expect, test } from "bun:test";

import { createHarness } from "../src/index.js";
import { queryMethod, queryProject } from "./helpers/queries.js";

const relationshipGet = (
    criteria = "",
    attributes = "",
) => `<Item type="QueryPart" action="get" orderBy="count">
    <Relationships><Item type="QueryLink" action="get" ${attributes}>
        ${criteria}
    </Item></Relationships>
</Item>`;

test("nested relationship hydration retains parents, filters before paging and scopes each collection", async () => {
    await using project = await queryProject();
    using h = await createHarness({ cwd: project.cwd });
    const all = await h.applyAML(relationshipGet("", 'orderBy="note" pagesize="1"'));
    const filtered = await h.applyAML(relationshipGet("<note>Second</note>"));
    const projection = await h.applyAML(relationshipGet("<note>Second</note>", 'isCriteria="0"'));

    expect(all.payload.items.map((node) => node.relationships.length)).toEqual([1, 1, 0, 0]);
    expect(all.payload.items[0]?.relationships[0]?.properties.note).toBe("First");
    expect(filtered.payload.items.map((node) => node.properties.name)).toEqual(["Alpha"]);
    expect(projection.payload.items.map((node) => node.relationships.length)).toEqual([1, 0, 0, 0]);
    const page = await h.applyAML(
        relationshipGet("<note>Other</note>").replace(
            'orderBy="count"',
            'orderBy="count" pagesize="1" page="1"',
        ),
    );
    expect(page.payload.items[0]?.properties.name).toBe("Beta");
    expect(page.payload.messages).toContainEqual({ name: "itemmax", value: "1" });
});

test("nested selectors and relationship gets execute their original source hooks once", async () => {
    const method = queryMethod(
        "MarkRead",
        `
        var audit = this.newItem("QueryPart", "add");
        audit.setProperty("name", "Relationship hook");
        audit.apply();
        return this;
    `,
    );
    await using project = await queryProject(`${method}
        <Item type="Server Event" action="add"><source_id>QUERY_LINK</source_id>
            <related_id>QUERY_MarkRead</related_id><server_event>onBeforeGet</server_event>
        </Item>`);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    await h.applyAML(`<Item type="QueryPart" action="get"><name>Alpha</name>
        <Relationships><Item type="QueryLink" action="get"/></Relationships>
    </Item>`);

    expect((await h.get("QueryPart", { name: "Relationship hook" })).length).toBe(1);
}, 60_000);

test("nested property actions and relationship additions, updates and deletes persist as one graph", async () => {
    await using project = await queryProject();
    using h = await createHarness({ cwd: project.cwd });
    const created = await h.applyAML(`<Item type="QueryPart" action="add"><name>New parent</name>
        <parent><Item type="QueryPart" action="get"><name>Alpha</name></Item></parent>
        <Relationships><Item type="QueryLink" action="add"><note>New link</note>
            <related_id><Item type="QueryPart" action="add"><name>New child</name></Item></related_id>
        </Item></Relationships>
    </Item>`);
    const id = created.getID();
    const link = created.node.relationships[0];

    if (!link?.attributes.id) {
        throw new Error("Expected the persisted relationship.");
    }

    await h.applyAML(`<Item type="QueryPart" action="update" id="${id}">
        <parent><Item type="QueryPart" action="get"><name>Beta</name></Item></parent>
        <Relationships><Item type="QueryLink" action="edit" id="${link.attributes.id}">
            <note>Edited</note>
        </Item></Relationships>
    </Item>`);
    expect((await h.getOne("QueryPart", { id })).properties.parent).toBe(
        (await h.getOne("QueryPart", { name: "Beta" })).id,
    );
    expect((await h.getOne("QueryLink", { id: link.attributes.id })).properties.note).toBe(
        "Edited",
    );

    await h.applyAML(`<Item type="QueryPart" action="update" id="${id}">
        <Relationships><Item type="QueryLink" action="delete" id="${link.attributes.id}"/></Relationships>
    </Item>`);
    expect((await h.get("QueryLink", { id: link.attributes.id })).length).toBe(0);
    expect((await h.get("QueryPart", { name: "New child" })).length).toBe(1);
});

test("cross-parent relationship writes and failed nested actions roll back earlier graph changes", async () => {
    await using project = await queryProject();
    using h = await createHarness({ cwd: project.cwd });
    const alpha = await h.getOne("QueryPart", { name: "Alpha" });
    const beta = await h.getOne("QueryPart", { name: "Beta" });
    const link = await h.getOne("QueryLink", { note: "Other" });

    await expect(
        h.applyAML(`<Item type="QueryPart" action="update" id="${alpha.id}">
        <note>Must roll back</note><Relationships>
            <Item type="QueryLink" action="add"><note>Transient link</note><related_id>${beta.id}</related_id></Item>
            <Item type="QueryLink" action="edit" id="${link.id}"><note>Wrong parent</note></Item>
        </Relationships>
    </Item>`),
    ).rejects.toThrow("another parent");
    expect((await h.getOne("QueryPart", { id: alpha.id })).properties.note).toBeNull();
    expect((await h.get("QueryLink", { note: "Transient link" })).length).toBe(0);
    expect((await h.getOne("QueryLink", { id: link.id })).properties.note).toBe("Other");

    await expect(
        h.applyAML(`<Item type="QueryPart" action="add"><name>Transient parent</name>
        <parent><Item type="QueryPart" action="get"/></parent>
    </Item>`),
    ).rejects.toThrow("must resolve one persisted Item");
    expect((await h.get("QueryPart", { name: "Transient parent" })).length).toBe(0);
});

test("nested query metadata is validated even when the parent selector returns no rows", async () => {
    await using project = await queryProject();
    using h = await createHarness({ cwd: project.cwd });
    await expect(
        h.applyAML(`<Item type="QueryPart" action="get"><name>Missing</name>
        <Relationships><Item type="Identity" action="get"/></Relationships>
    </Item>`),
    ).rejects.toThrow("not an imported relationship");
});

test("relationship hooks cannot retarget writes outside their owning parent", async () => {
    const method = queryMethod(
        "RetargetLink",
        `
        var target = this.newItem("QueryLink", "get");
        target.setProperty("note", "Other");
        var other = target.apply();
        this.setID(other.getID());
        return this;
    `,
    );
    await using project = await queryProject(`${method}
        <Item type="Server Event" action="add"><source_id>QUERY_LINK</source_id>
            <related_id>QUERY_RetargetLink</related_id><server_event>onBeforeUpdate</server_event>
        </Item>`);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const parent = await h.getOne("QueryPart", { name: "Alpha" });
    const link = await h.getOne("QueryLink", { note: "First" });
    await expect(
        h.applyAML(`<Item type="QueryPart" action="update" id="${parent.id}">
        <note>Must roll back</note><Relationships>
            <Item type="QueryLink" action="edit" id="${link.id}"><note>Changed</note></Item>
        </Relationships>
    </Item>`),
    ).rejects.toThrow("cannot change");

    expect((await h.getOne("QueryLink", { note: "Other" })).properties.source_id).toBe(
        (await h.getOne("QueryPart", { name: "Beta" })).id,
    );
    expect((await h.getOne("QueryPart", { id: parent.id })).properties.note).toBeNull();
}, 60_000);
