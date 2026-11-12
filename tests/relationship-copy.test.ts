import { expect, test } from "bun:test";

import { createHarness, ExecutionOutcome } from "../src/index.js";
import { ServerEventVersion } from "../src/platform/events/types.js";
import { referenceEvent, referenceMethod, referenceProject } from "./helpers/references.js";

const collection = { version: ServerEventVersion.Collection };

const versionedLink = `<Item type="ItemType" action="edit" id="ReferenceFixed"><is_versionable>1</is_versionable></Item>`;

test("parent versions preserve stored relationship values without running copy Methods", async () => {
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
            .map((record) => record.properties.sort_order)
            .sort((left, right) => Number(left) - Number(right)),
    ).toEqual([1, 2]);
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
    ).toEqual([]);
    expect(h.executions.at(-1)?.mocks).toEqual([]);
}, 60_000);

test("a rejecting after-version Method rolls back completed relationship copies and nested writes", async () => {
    const source =
        referenceMethod(
            "RejectCopiedVersion",
            `
            var links = this.newItem("ReferenceFixed", "get");
            links.setProperty("source_id", eventData.NewItemId);
            if (links.apply().getItemCount() != 1) {
                throw new Exception("Version hooks ran before relationship copies existed");
            }
            var audit = this.newItem("ReferenceHolder", "add");
            audit.setProperty("name", "Must roll back");
            var result = audit.apply();
            if (result.isError()) { return result; }
            return this.getInnovator().newError("Reject copied version");
        `,
        ) + referenceEvent("REF_RECORD", "onAfterVersion", "RejectCopiedVersion");
    await using project = await referenceProject(source);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const parent = await h.getOne("ReferenceRecord", { name: "Parent" });
    const child = await h.getOne("ReferenceRecord", { name: "Child" });
    await h.add("ReferenceFixed", { source_id: parent.id, related_id: child.id });
    const records = h.state.get("ReferenceRecord");
    const links = h.state.get("ReferenceFixed");
    await expect(h.update(parent, { name: "Rejected" })).rejects.toThrow("Reject copied version");

    expect(h.state.get("ReferenceRecord")).toEqual(records);
    expect(h.state.get("ReferenceFixed")).toEqual(links);
    expect(h.state.get("ReferenceHolder")).toEqual([]);
    expect(h.executions.at(-1)?.changes.filter((change) => change.name === "copy")).toHaveLength(1);
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

test("nested owned records exist before after-version and retain valid dependency owners", async () => {
    const schema = `<Item type="ItemType" action="add" id="OWNED_DETAIL"><name>OwnedDetail</name><is_relationship>1</is_relationship><is_dependent>1</is_dependent><Relationships>
        <Item type="Property" action="add"><name>value</name><data_type>string</data_type></Item>
    </Relationships></Item><Item type="RelationshipType" action="add"><name>OwnedDetail</name>
        <relationship_id>OWNED_DETAIL</relationship_id><source_id>ReferenceFixed</source_id>
    </Item>`;
    const source =
        referenceMethod(
            "CheckNestedVersion",
            `
        var links = this.newItem("ReferenceFixed", "get");
        links.setProperty("source_id", eventData.NewItemId);
        var copied = links.apply();
        if (copied.getItemCount() != 1) throw new Exception("Missing copied relationship");
        for (int index = 0; index < copied.getItemCount(); index++) {
            var nested = this.newItem("OwnedDetail", "get");
            nested.setProperty("source_id", copied.getItemByIndex(index).getID());
            var result = nested.apply();
            if (result.getItemCount() != 1 || result.getProperty("value") != "Nested") throw new Exception("Owned records are missing");
        }
        return this;
    `,
        ) + referenceEvent("REF_RECORD", "onAfterVersion", "CheckNestedVersion");
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

test("suppressed copy Methods cannot rewrite the copied system identities", async () => {
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
    const links = h.state.get("ReferenceFixed");
    const saved = await h.update(parent, { name: "Saved" });
    const copied = h.state.getOne("ReferenceFixed", { source_id: saved.id });

    expect(copied.properties).toMatchObject({ config_id: copied.id, generation: 1 });

    for (const link of links) {
        expect(h.state.getOne("ReferenceFixed", { id: link.id })).toEqual({
            ...link,
            properties: { ...link.properties, behavior: "hard_fixed" },
        });
    }

    expect(h.trace.some((event) => event.name === "ChangeCopyIdentity")).toBe(false);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.Committed);
}, 60_000);

test("required and optional business copy hooks are skipped even with serverEvents=0", async () => {
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
    ).toEqual([]);
}, 60_000);
