import { expect, test } from "bun:test";

import { createHarness, ExecutionOutcome } from "../src/index.js";
import { referenceProject } from "./helpers/references.js";
import { revisionFixtures, revisionProject, revisionSchema } from "./helpers/revisions.js";

const alternate = `<Item type="Life Cycle Map" action="add" id="SPECIAL_CYCLE"><name>Special lifecycle</name><start_state>SPECIAL_START</start_state><Relationships>
    <Item type="Life Cycle State" action="add" id="SPECIAL_START"><name>Prototype</name><item_behavior>float</item_behavior></Item>
    <Item type="Life Cycle State" action="add" id="SPECIAL_RELEASED"><name>Approved</name><set_is_released>1</set_is_released><set_not_lockable>1</set_not_lockable></Item>
    <Item type="Life Cycle Transition" action="add"><from_state>SPECIAL_START</from_state><to_state>SPECIAL_RELEASED</to_state></Item>
</Relationships></Item><Item type="ItemType Life Cycle" action="add"><source_id>REVISION_DOCUMENT</source_id><related_id>SPECIAL_CYCLE</related_id><class_path>Special</class_path></Item>`;

const workflow = `<Item type="Workflow Map" action="add" id="REVISION_WORKFLOW"><name>Revision workflow</name></Item>
    <Item type="Life Cycle State" action="edit" id="REVISION_DRAFT"><workflow>REVISION_WORKFLOW</workflow></Item>`;

test("revision reset selects the imported lifecycle for the stored classification", async () => {
    await using project = await revisionProject(alternate);
    using h = await createHarness({ cwd: project.cwd });
    const record = await h.add("RevisionDocument", {
        name: "Special document",
        classification: "Special/Material",
    });
    const promoted = await h.applyAML(
        `<Item type="RevisionDocument" action="promoteItem" id="${record.id}"><state>Approved</state></Item>`,
    );
    const revised = await h.applyAML(
        `<Item type="RevisionDocument" action="version" id="${promoted.getID()}" />`,
    );

    expect(revised.node.properties).toMatchObject({
        major_rev: "C",
        generation: 2,
        state: "Prototype",
        current_state: "SPECIAL_START",
        is_released: 0,
        not_lockable: 0,
        classification: "Special/Material",
    });
    expect(h.state.getOne("RevisionDocument", { id: record.id }).properties.state).toBe("Approved");
});

test("a revised classification selects its new start state instead of retaining a state from the old map", async () => {
    await using project = await revisionProject(alternate);
    using h = await createHarness({ cwd: project.cwd });
    const record = await h.getOne("RevisionDocument", { name: "Released document" });
    const revised =
        await h.applyAML(`<Item type="RevisionDocument" action="version" id="${record.id}">
        <classification>Special/Material</classification></Item>`);

    expect(revised.node.properties).toMatchObject({
        major_rev: "C",
        state: "Prototype",
        current_state: "SPECIAL_START",
        classification: "Special/Material",
    });
    expect(h.state.getOne("RevisionDocument", { id: record.id }).properties.state).toBe("Released");
});

test("normal creation applies the lifecycle start while fixture seeding retains its declared scenario state", async () => {
    await using project = await revisionProject();
    using h = await createHarness({ cwd: project.cwd });
    const record = await h.add("RevisionDocument", {
        name: "Created",
        state: "Released",
        current_state: "REVISION_RELEASED",
        is_released: 1,
        not_lockable: 1,
    });

    expect(record.properties).toMatchObject({
        state: "Draft",
        current_state: "REVISION_DRAFT",
        is_released: 0,
        not_lockable: 0,
    });
    expect(h.state.getOne("RevisionDocument", { name: "Released document" }).properties.state).toBe(
        "Released",
    );
});

test("starting-state workflow requirements cannot be silently skipped when a released item revises", async () => {
    await using project = await revisionProject(workflow);
    using h = await createHarness({ cwd: project.cwd });
    const record = await h.getOne("RevisionDocument", { name: "Released document" });
    const before = h.state.get("RevisionDocument");
    await expect(
        h.applyAML(`<Item type="RevisionDocument" action="version" id="${record.id}" />`),
    ).rejects.toMatchObject({ code: "UnsupportedWorkflow" });

    expect(h.state.get("RevisionDocument")).toEqual(before);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
    expect(h.executions.at(-1)?.error?.source?.file).toEndWith("source.xml");
    await expect(h.add("RevisionDocument", { name: "Must not create" })).rejects.toMatchObject({
        code: "UnsupportedWorkflow",
    });
    expect(h.state.get("RevisionDocument", { name: "Must not create" })).toHaveLength(0);
});

test("a reset with an unusable start state fails before it can persist a new generation", async () => {
    const source = revisionSchema.replace(
        "<start_state>REVISION_DRAFT</start_state>",
        '<start_state is_null="1" />',
    );
    await using project = await referenceProject(source, revisionFixtures);
    using h = await createHarness({ cwd: project.cwd });
    const record = await h.getOne("RevisionDocument", { name: "Released document" });
    const before = h.state.get("RevisionDocument");
    await expect(
        h.applyAML(`<Item type="RevisionDocument" action="version" id="${record.id}" />`),
    ).rejects.toMatchObject({ code: "InvalidLifeCycle" });

    expect(h.state.get("RevisionDocument")).toEqual(before);
});
