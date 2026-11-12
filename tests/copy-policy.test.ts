import { expect, test } from "bun:test";
import { realpath } from "node:fs/promises";
import { join } from "node:path";

import { CapabilityId, createHarness, ExecutionOutcome } from "../src/index.js";
import { referenceProject } from "./helpers/references.js";

const fixtures = `ReferenceFixed: [{ source_id: { name: "Parent" },
    related_id: { name: "Child" }, sort_order: 7 }],`;
const fileContainerId = "41EF49EFD2ED4F6EAB04C047681F33AC";

test.each([
    { transitive: false, renamed: false },
    { transitive: true, renamed: false },
    { transitive: true, renamed: true },
])(
    "native file-container copies require their internal services, including renamed metadata: %j",
    async ({ transitive, renamed }) => {
        const middle = transitive
            ? `<Item type="ItemType" action="add" id="COPY_MIDDLE">
            <name>CopyMiddle</name><implementation_type>polymorphic</implementation_type></Item>
            <Item type="Morphae" action="add"><source_id>${fileContainerId}</source_id>
                <related_id>COPY_MIDDLE</related_id></Item>`
            : "";
        const schema = `<Item type="ItemType" action="add" id="${fileContainerId}">
            <name>${renamed ? "RenamedFileContainer" : "FileContainerItems"}</name>
            <implementation_type>polymorphic</implementation_type></Item>
            ${middle}
            <Item type="Morphae" action="add"><source_id>${transitive ? "COPY_MIDDLE" : fileContainerId}</source_id>
                <related_id>ReferenceFixed</related_id></Item>`;
        await using project = await referenceProject(schema, fixtures);
        using h = await createHarness({ cwd: project.cwd });
        const parent = await h.getOne("ReferenceRecord", { name: "Parent" });
        const records = h.state.get("ReferenceRecord");
        const links = h.state.get("ReferenceFixed");
        const sourceFile = await realpath(join(project.cwd, ".harness/packages/source.xml"));

        await expect(h.update(parent, { name: "Rejected" })).rejects.toMatchObject({
            code: "UnsupportedFileCopy",
            capability: CapabilityId.Vault,
            source: { file: sourceFile },
        });
        expect(h.state.get("ReferenceRecord")).toEqual(records);
        expect(h.state.get("ReferenceFixed")).toEqual(links);
        expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
    },
);

test("released versionable relationship copies retain their revision diagnostic and rollback", async () => {
    const schema = `<Item type="ItemType" action="edit" id="ReferenceFixed">
        <is_versionable>1</is_versionable></Item>`;
    const released = `ReferenceFixed: [{ source_id: { name: "Parent" },
        related_id: { name: "Child" }, is_released: 1 }],`;
    await using project = await referenceProject(schema, released);
    using h = await createHarness({ cwd: project.cwd });
    const parent = await h.getOne("ReferenceRecord", { name: "Parent" });
    const before = h.state.get("ReferenceRecord");
    const links = h.state.get("ReferenceFixed");

    await expect(h.update(parent, { name: "Rejected" })).rejects.toMatchObject({
        code: "UnsupportedRevision",
        capability: CapabilityId.Revision,
    });
    expect(h.state.get("ReferenceRecord")).toEqual(before);
    expect(h.state.get("ReferenceFixed")).toEqual(links);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
});

test("parent copies contain stored columns while foreign values remain calculated", async () => {
    const schema = `<Item type="ItemType" action="edit" id="ReferenceFixed"><Relationships>
        <Item type="Property" action="add"><name>related_name</name><data_type>foreign</data_type>
            <data_source><Item type="Property" action="get">
                <source_id>ReferenceFixed</source_id><name>related_id</name></Item></data_source>
            <foreign_property><Item type="Property" action="get">
                <source_id>REF_RECORD</source_id><name>name</name></Item></foreign_property>
        </Item>
    </Relationships></Item>`;
    await using project = await referenceProject(schema, fixtures);
    using h = await createHarness({ cwd: project.cwd });
    const parent = await h.getOne("ReferenceRecord", { name: "Parent" });
    const next = await h.update(parent, { name: "Saved" });
    const copied = await h.getOne("ReferenceFixed", { source_id: next.id });

    expect(copied.properties.related_name).toBe("Child");
    expect(h.state.getOne("ReferenceFixed", { id: copied.id }).properties).not.toHaveProperty(
        "related_name",
    );
    expect(
        h.state.getOne("ReferenceFixed", { source_id: parent.id }).properties,
    ).not.toHaveProperty("related_name");
    expect(h.state.getOne("ReferenceFixed", { id: copied.id }).properties.sort_order).toBe(7);
});
