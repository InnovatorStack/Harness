import { expect, test } from "bun:test";

import { createHarness, ExecutionOutcome } from "../src/index.js";
import { referenceEvent, referenceMethod, referenceProject } from "./helpers/references.js";

const shared = `ReferenceNote: [{ name: "Shared" }], ReferenceHolder: [
    { name: "First owner", note: { name: "Shared" } },
    { name: "Second owner", note: { name: "Shared" } },
]`;

test("deleting a parent removes its owned relationship records and preserves independent related Items", async () => {
    await using project = await referenceProject();
    using h = await createHarness({ cwd: project.cwd });
    const parent = await h.getOne("ReferenceRecord", { name: "Parent" });
    const child = await h.getOne("ReferenceRecord", { name: "Child" });
    await h.add("ReferenceFixed", { source_id: parent.id, related_id: child.id });
    const next = await h.update(parent, { name: "Next parent" });
    await h.delete(next);

    expect(h.state.get("ReferenceFixed")).toHaveLength(0);
    expect(h.state.get("ReferenceRecord", { config_id: parent.id })).toHaveLength(0);
    expect((await h.getOne("ReferenceRecord", { id: child.id })).properties.name).toBe("Child");
});

test("a shared dependent Item survives until its final owning reference is deleted", async () => {
    await using project = await referenceProject("", shared);
    using h = await createHarness({ cwd: project.cwd });
    const first = await h.getOne("ReferenceHolder", { name: "First owner" });
    const second = await h.getOne("ReferenceHolder", { name: "Second owner" });
    await h.delete(first);
    expect((await h.get("ReferenceNote", { name: "Shared" })).length).toBe(1);
    await h.delete(second);
    expect(h.state.get("ReferenceNote")).toHaveLength(0);
});

test("clearing a final item-property reference deletes its dependent target", async () => {
    await using project = await referenceProject("", shared);
    using h = await createHarness({ cwd: project.cwd });
    const first = await h.getOne("ReferenceHolder", { name: "First owner" });
    const second = await h.getOne("ReferenceHolder", { name: "Second owner" });
    await h.update(first, { note: null });
    expect(h.state.get("ReferenceNote")).toHaveLength(1);
    await h.update(second, { note: null });
    expect(h.state.get("ReferenceNote")).toHaveLength(0);
});

test("dependent creation requires a real owner while nested property creation works automatically", async () => {
    await using project = await referenceProject();
    using h = await createHarness({ cwd: project.cwd });
    await expect(h.add("ReferenceNote", { name: "Orphan" })).rejects.toThrow(
        "requires an owning reference",
    );
    expect(h.state.get("ReferenceNote")).toHaveLength(0);
    const created = await h.applyAML(`<Item type="ReferenceHolder" action="add"><name>Owner</name>
        <note><Item type="ReferenceNote" action="add"><name>Owned</name></Item></note>
    </Item>`);

    expect(created.isError()).toBe(false);
    expect(h.state.getOne("ReferenceHolder", { name: "Owner" }).properties.note).toBe(
        h.state.getOne("ReferenceNote", { name: "Owned" }).id,
    );
});

test("a real C# Method may create a dependent then attach it within the same outer request", async () => {
    const source = referenceMethod(
        "CreateOwned",
        `
        var child = this.newItem("ReferenceNote", "add");
        child.setProperty("name", "Created by source");
        child = child.apply();
        if (child.isError()) return child;
        var parent = this.newItem("ReferenceHolder", "add");
        parent.setProperty("name", "Owner created by source");
        parent.setProperty("note", child.getID());
        return parent.apply();
    `,
    );
    await using project = await referenceProject(source);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const result = await h.callMethod("CreateOwned");

    expect(result.isError()).toBe(false);
    expect(
        h.state.getOne("ReferenceHolder", { name: "Owner created by source" }).properties.note,
    ).toBe(h.state.getOne("ReferenceNote", { name: "Created by source" }).id);
}, 60_000);

test("a rejected dependent delete restores the parent, links and nested Method writes", async () => {
    const source = referenceMethod(
        "RejectDelete",
        `
        var audit = this.newItem("ReferenceHolder", "add");
        audit.setProperty("name", "Must roll back");
        audit.apply();
        return this.getInnovator().newError("Reject dependent delete");
    `,
    );
    await using project = await referenceProject(
        `${source}${referenceEvent("REF_NOTE", "onBeforeDelete", "RejectDelete")}`,
    );
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const result = await h.applyAML(`<Item type="ReferenceRecord" action="add"><name>Owner</name>
        <Relationships><Item type="ReferenceNotes" action="add">
            <related_id><Item type="ReferenceNote" action="add"><name>Owned note</name></Item></related_id>
        </Item></Relationships>
    </Item>`);
    const owner = await h.getOne("ReferenceRecord", { id: result.getID() });
    await expect(h.delete(owner)).rejects.toThrow("Reject dependent delete");

    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
    expect(h.state.get("ReferenceRecord", { id: owner.id })).toHaveLength(1);
    expect(h.state.get("ReferenceNotes", { source_id: owner.id })).toHaveLength(1);
    expect(h.state.get("ReferenceNote", { name: "Owned note" })).toHaveLength(1);
    expect(h.state.get("ReferenceHolder", { name: "Must roll back" })).toHaveLength(0);
}, 60_000);

test("external references reject deletion as a business error and restore cascaded children", async () => {
    await using project = await referenceProject();
    using h = await createHarness({ cwd: project.cwd });
    const parent = await h.getOne("ReferenceRecord", { name: "Parent" });
    const child = await h.getOne("ReferenceRecord", { name: "Child" });
    const other = await h.getOne("ReferenceRecord", { name: "Other parent" });
    await h.add("ReferenceFixed", { source_id: parent.id, related_id: child.id });
    await h.update(other, { fixed_ref: parent.id });
    const result = await h.applyAML(
        `<Item type="ReferenceRecord" action="delete" id="${parent.id}"/>`,
    );

    expect(result.getErrorCode()).toBe("ReferencedItem");
    expect(h.state.get("ReferenceRecord", { id: parent.id })).toHaveLength(1);
    expect(h.state.get("ReferenceFixed", { source_id: parent.id })).toHaveLength(1);
});

test("deleting a version family allows internal references without leaving dangling records", async () => {
    await using project = await referenceProject();
    using h = await createHarness({ cwd: project.cwd });
    const parent = await h.getOne("ReferenceRecord", { name: "Parent" });
    const next = await h.update(parent, { fixed_ref: parent.id });
    await h.delete(next);

    expect(h.state.get("ReferenceRecord", { config_id: parent.id })).toHaveLength(0);
});

test("automatic cascades execute parent, relationship and dependent event chains in order", async () => {
    const events = [
        ["REF_RECORD", "onBeforeDelete", "ParentBefore"],
        ["REF_RECORD", "onAfterDelete", "ParentAfter"],
        ["ReferenceNotes", "onBeforeDelete", "LinkBefore"],
        ["ReferenceNotes", "onAfterDelete", "LinkAfter"],
        ["REF_NOTE", "onBeforeDelete", "NoteBefore"],
        ["REF_NOTE", "onAfterDelete", "NoteAfter"],
    ];
    const source = events
        .map(([type, event, name]) => {
            if (!type || !event || !name) {
                throw new Error("Expected a complete event binding.");
            }

            return referenceMethod(name, "return this;") + referenceEvent(type, event, name);
        })
        .join("");
    await using project = await referenceProject(source);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const created = await h.applyAML(`<Item type="ReferenceRecord" action="add"><name>Owner</name>
        <Relationships><Item type="ReferenceNotes" action="add">
            <related_id><Item type="ReferenceNote" action="add"><name>Owned</name></Item></related_id>
        </Item></Relationships>
    </Item>`);
    const owner = await h.getOne("ReferenceRecord", { id: created.getID() });
    const start = h.trace.length;
    await h.delete(owner);

    expect(
        h.trace
            .slice(start)
            .filter((event) => event.kind === "method")
            .map((event) => event.name),
    ).toEqual([
        "ParentBefore",
        "LinkBefore",
        "NoteBefore",
        "NoteAfter",
        "LinkAfter",
        "ParentAfter",
    ]);
}, 60_000);

test("cyclic ownership cannot manufacture a parent for orphaned dependent Items", async () => {
    const field = `<Item type="ItemType" action="edit" id="REF_NOTE"><Relationships>
        <Item type="Property" action="add"><name>next</name><data_type>item</data_type><data_source>REF_NOTE</data_source></Item>
    </Relationships></Item>`;
    const method = referenceMethod(
        "CreateOrphanCycle",
        `
        var first = this.newItem("ReferenceNote", "add");
        first.setProperty("name", "First");
        first = first.apply();
        var second = this.newItem("ReferenceNote", "add");
        second.setProperty("name", "Second");
        second.setProperty("next", first.getID());
        second = second.apply();
        var update = this.newItem("ReferenceNote", "edit");
        update.setID(first.getID());
        update.setProperty("next", second.getID());
        return update.apply();
    `,
    );
    await using project = await referenceProject(field + method);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const result = await h.callMethod("CreateOrphanCycle");

    expect(result.getErrorCode()).toBe("DependentItem");
    expect(h.state.get("ReferenceNote")).toHaveLength(0);
}, 60_000);

test("cyclic relationship ownership fails before recursive delete can exhaust the runtime", async () => {
    const schema = `<Item type="ItemType" action="add" id="OWNED_NODE"><name>OwnedNode</name><is_relationship>1</is_relationship><Relationships>
        <Item type="Property" action="add"><name>name</name><data_type>string</data_type></Item>
    </Relationships></Item><Item type="RelationshipType" action="add"><name>OwnedNode</name>
        <relationship_id>OWNED_NODE</relationship_id><source_id>OWNED_NODE</source_id>
    </Item>`;
    const fixtures = `OwnedNode: [
        { name: "First", source_id: { name: "Second" } },
        { name: "Second", source_id: { name: "First" } },
    ]`;
    await using project = await referenceProject(schema, fixtures);
    using h = await createHarness({ cwd: project.cwd });
    const first = await h.getOne("OwnedNode", { name: "First" });
    await expect(h.delete(first)).rejects.toThrow("Cyclic deletion");

    expect(h.state.get("OwnedNode")).toHaveLength(2);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
});
