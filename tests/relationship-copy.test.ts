import { expect, test } from "bun:test";

import { createHarness, ExecutionOutcome } from "../src/index.js";
import { ServerEventVersion } from "../src/platform/events/types.js";
import { referenceEvent, referenceMethod, referenceProject } from "./helpers/references.js";

const collection = { version: ServerEventVersion.Collection };

const versionedLink = `<Item type="ItemType" action="edit" id="ReferenceFixed"><is_versionable>1</is_versionable></Item>`;

test("parent versioning copies a relationship collection with real before/after Methods", async () => {
    const source =
        referenceMethod(
            "BeforeCopy",
            `
        if (this.getItemCount() != 2) throw new Exception("Copy must use the entire collection");
        for (int index = 0; index < this.getItemCount(); index++) {
            this.getItemByIndex(index).setProperty("sort_order", "99");
        }
        return this;
    `,
        ) +
        referenceEvent("ReferenceFixed", "onBeforeCopy", "BeforeCopy", collection) +
        referenceMethod(
            "AfterCopy",
            `
        if (this.getItemCount() != 2) throw new Exception("Missing copied collection");
        for (int index = 0; index < this.getItemCount(); index++) {
            var record = this.getItemByIndex(index);
            if (record.getProperty("sort_order") != "99") throw new Exception("Before-copy changes lost");
            var parent = this.newItem("ReferenceRecord", "get");
            parent.setID(record.getProperty("source_id"));
            if (parent.apply().getProperty("is_current") != "1") throw new Exception("Wrong copy owner");
        }
        return this;
    `,
        ) +
        referenceEvent("ReferenceFixed", "onAfterCopy", "AfterCopy", collection) +
        referenceMethod("ItemCopyMustNotRun", 'throw new Exception("Version 1 copy hook ran");') +
        referenceEvent("ReferenceFixed", "onBeforeCopy", "ItemCopyMustNotRun");
    await using project = await referenceProject(source);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const parent = await h.getOne("ReferenceRecord", { name: "Parent" });
    const child = await h.getOne("ReferenceRecord", { name: "Child" });
    const other = await h.getOne("ReferenceRecord", { name: "Other parent" });
    await h.add("ReferenceFixed", { source_id: parent.id, related_id: child.id, sort_order: 1 });
    await h.add("ReferenceFixed", { source_id: parent.id, related_id: other.id, sort_order: 2 });
    const start = h.trace.length;
    const next = await h.update(parent, { name: "New parent" });

    expect(
        h.state
            .get("ReferenceFixed", { source_id: next.id })
            .every((record) => record.properties.sort_order === 99),
    ).toBe(true);
    expect(
        h.state
            .get("ReferenceFixed", { source_id: parent.id })
            .map((record) => record.properties.sort_order)
            .sort((left, right) => Number(left) - Number(right)),
    ).toEqual([1, 2]);
    expect(
        h.trace
            .slice(start)
            .filter((event) => event.kind === "method")
            .map((event) => event.name),
    ).toEqual(["BeforeCopy", "AfterCopy"]);
}, 60_000);

test("a rejected after-copy collection restores parent identity, relationship values and locks", async () => {
    const source =
        referenceMethod(
            "RejectCopy",
            'return this.getInnovator().newError("Reject copied collection");',
        ) + referenceEvent("ReferenceFixed", "onAfterCopy", "RejectCopy", collection);
    await using project = await referenceProject(source);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const parent = await h.getOne("ReferenceRecord", { name: "Parent" });
    const child = await h.getOne("ReferenceRecord", { name: "Child" });
    await h.add("ReferenceFixed", { source_id: parent.id, related_id: child.id });
    const records = h.state.get("ReferenceRecord");
    const links = h.state.get("ReferenceFixed");
    await expect(h.update(parent, { name: "Rejected" })).rejects.toThrow(
        "Reject copied collection",
    );

    expect(h.state.get("ReferenceRecord")).toEqual(records);
    expect(h.state.get("ReferenceFixed")).toEqual(links);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
}, 60_000);

test("versionable relationship copies start fresh configurations and preserve their original history", async () => {
    await using project = await referenceProject(versionedLink);
    using h = await createHarness({ cwd: project.cwd });
    const parent = await h.getOne("ReferenceRecord", { name: "Parent" });
    const child = await h.getOne("ReferenceRecord", { name: "Child" });
    const first = await h.add("ReferenceFixed", {
        source_id: parent.id,
        related_id: child.id,
        sort_order: 1,
    });
    const latest = await h.update(first, { sort_order: 2 });
    const newParent = await h.update(parent, { name: "New parent" });
    const copied = await h.getOne("ReferenceFixed", { source_id: newParent.id });

    expect(copied.id).not.toBe(latest.id);
    expect(copied.properties).toMatchObject({
        config_id: copied.id,
        generation: 1,
        is_current: 1,
        source_id: newParent.id,
        sort_order: 2,
        locked_by_id: null,
    });
    expect(h.state.get("ReferenceFixed", { source_id: parent.id })).toHaveLength(2);
    expect(h.state.getOne("ReferenceFixed", { id: first.id }).properties.sort_order).toBe(1);
    expect(h.state.getOne("ReferenceFixed", { id: latest.id }).properties.sort_order).toBe(2);
});

test("nested edits follow copied relationship generations in XML declaration order", async () => {
    await using project = await referenceProject(versionedLink);
    using h = await createHarness({ cwd: project.cwd });
    const parent = await h.getOne("ReferenceRecord", { name: "Parent" });
    const child = await h.getOne("ReferenceRecord", { name: "Child" });
    const link = await h.add("ReferenceFixed", {
        source_id: parent.id,
        related_id: child.id,
        sort_order: 1,
    });
    const result = await h.applyAML(`<Item type="ReferenceRecord" action="edit" id="${parent.id}">
        <Relationships>
            <Item type="ReferenceFixed" action="edit" id="${link.id}"><sort_order>10</sort_order></Item>
            <Item type="ReferenceFixed" action="edit" id="${link.id}"><sort_order>20</sort_order></Item>
        </Relationships>
    </Item>`);
    const current = await h.getOne("ReferenceFixed", { source_id: result.getID() });

    expect(current.properties.sort_order).toBe(20);
    expect(current.properties.generation).toBe(3);
    expect(h.state.getOne("ReferenceFixed", { id: link.id }).properties.sort_order).toBe(1);
});

test("nested owned records exist before the parent's after-copy Method and retain a valid dependency owner", async () => {
    const schema = `<Item type="ItemType" action="add" id="OWNED_DETAIL"><name>OwnedDetail</name><is_relationship>1</is_relationship><is_dependent>1</is_dependent><Relationships>
        <Item type="Property" action="add"><name>value</name><data_type>string</data_type></Item>
    </Relationships></Item><Item type="RelationshipType" action="add"><name>OwnedDetail</name>
        <relationship_id>OWNED_DETAIL</relationship_id><source_id>ReferenceFixed</source_id>
    </Item>`;
    const source =
        referenceMethod(
            "CheckNestedCopy",
            `
        for (int index = 0; index < this.getItemCount(); index++) {
            var nested = this.newItem("OwnedDetail", "get");
            nested.setProperty("source_id", this.getItemByIndex(index).getID());
            var result = nested.apply();
            if (result.getItemCount() != 1 || result.getProperty("value") != "Nested") throw new Exception("Owned records are missing");
        }
        return this;
    `,
        ) + referenceEvent("ReferenceFixed", "onAfterCopy", "CheckNestedCopy", collection);
    await using project = await referenceProject(schema + source);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const child = await h.getOne("ReferenceRecord", { name: "Child" });
    const created = await h.applyAML(`<Item type="ReferenceRecord" action="add"><name>Owner</name>
        <Relationships><Item type="ReferenceFixed" action="add"><related_id>${child.id}</related_id>
            <Relationships><Item type="OwnedDetail" action="add"><value>Nested</value></Item></Relationships>
        </Item></Relationships>
    </Item>`);
    const parent = await h.getOne("ReferenceRecord", { id: created.getID() });
    const next = await h.update(parent, { name: "New owner" });
    const link = await h.getOne("ReferenceFixed", { source_id: next.id });

    expect(h.state.get("OwnedDetail")).toHaveLength(2);
    expect(h.state.getOne("OwnedDetail", { source_id: link.id }).properties.value).toBe("Nested");
}, 60_000);

test("before-copy identity changes fail explicitly and restore every source record", async () => {
    const source =
        referenceMethod(
            "ChangeCopyIdentity",
            `
        this.getItemByIndex(0).setProperty("generation", "999");
        return this;
    `,
        ) + referenceEvent("ReferenceFixed", "onBeforeCopy", "ChangeCopyIdentity", collection);
    await using project = await referenceProject(source);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const parent = await h.getOne("ReferenceRecord", { name: "Parent" });
    const child = await h.getOne("ReferenceRecord", { name: "Child" });
    await h.add("ReferenceFixed", { source_id: parent.id, related_id: child.id });
    const records = h.state.get("ReferenceRecord");
    const links = h.state.get("ReferenceFixed");

    await expect(h.update(parent, { name: "Rejected" })).rejects.toThrow("managed by the platform");
    expect(h.state.get("ReferenceRecord")).toEqual(records);
    expect(h.state.get("ReferenceFixed")).toEqual(links);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
}, 60_000);

test("required copy hooks run with serverEvents=0 and optional copy hooks remain suppressed", async () => {
    const source =
        referenceMethod("OptionalCopy", 'throw new Exception("Optional copy ran");') +
        referenceEvent("ReferenceFixed", "onBeforeCopy", "OptionalCopy", collection) +
        referenceMethod("RequiredCopy", "return this;") +
        referenceEvent("ReferenceFixed", "onAfterCopy", "RequiredCopy", {
            ...collection,
            required: true,
        });
    await using project = await referenceProject(source);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const parent = await h.getOne("ReferenceRecord", { name: "Parent" });
    const child = await h.getOne("ReferenceRecord", { name: "Child" });
    await h.add("ReferenceFixed", { source_id: parent.id, related_id: child.id });
    const start = h.trace.length;
    const result = await h.applyAML(`<Item type="ReferenceRecord" action="edit" id="${parent.id}"
        serverEvents="0"><name>Updated</name></Item>`);

    expect(result.isError()).toBe(false);
    expect(h.state.get("ReferenceFixed", { source_id: result.getID() })).toHaveLength(1);
    expect(
        h.trace
            .slice(start)
            .filter((event) => event.kind === "method")
            .map((event) => event.name),
    ).toEqual(["RequiredCopy"]);
}, 60_000);
