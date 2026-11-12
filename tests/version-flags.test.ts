import { expect, test } from "bun:test";

import { createHarness } from "../src/index.js";
import { referenceMethod, referenceProject } from "./helpers/references.js";

test("new_version marks a saved generation and locking again preserves that marker", async () => {
    await using project = await referenceProject();
    using h = await createHarness({ cwd: project.cwd });
    const original = await h.add("ReferenceRecord", { name: "Original" });

    expect(original.properties.new_version).toBe(0);
    await h.applyAML(
        `<Item type="ReferenceRecord" action="lock" id="${original.id}" doGetItem="0" />`,
    );
    expect(h.state.getOne("ReferenceRecord", { id: original.id }).properties.new_version).toBe(0);
    const first = await h.applyAML(
        `<Item type="ReferenceRecord" action="update" id="${original.id}"><name>First save</name></Item>`,
    );

    expect(first.node.properties.new_version).toBe(1);
    expect(first.getID()).not.toBe(original.id);
    await h.applyAML(
        `<Item type="ReferenceRecord" action="lock" id="${first.getID()}" doGetItem="0" />`,
    );
    const second = await h.applyAML(
        `<Item type="ReferenceRecord" action="update" id="${first.getID()}"><name>Second save</name></Item>`,
    );

    expect(second.getID()).toBe(first.getID());
    expect(second.node.properties).toMatchObject({ generation: 2, new_version: 1 });
    await h.applyAML(
        `<Item type="ReferenceRecord" action="unlock" id="${second.getID()}" doGetItem="0" />`,
    );
    expect(h.state.getOne("ReferenceRecord", { id: second.getID() }).properties.new_version).toBe(
        0,
    );
});

test("manual versioning retains its native marker across ordinary saves, explicit version and unlock", async () => {
    const metadata =
        '<Item type="ItemType" action="edit" id="REF_RECORD"><manual_versioning>1</manual_versioning></Item>';
    await using project = await referenceProject(metadata);
    using h = await createHarness({ cwd: project.cwd });
    const original = await h.add("ReferenceRecord", { name: "Manual" });
    const saved = await h.update(original, { name: "Manual save" });

    expect(saved.id).toBe(original.id);
    expect(saved.properties.new_version).toBe(1);
    const versioned = await h.applyAML(
        `<Item type="ReferenceRecord" action="version" id="${saved.id}" />`,
    );

    expect(versioned.getID()).not.toBe(original.id);
    expect(versioned.node.properties.new_version).toBe(1);
    await h.applyAML(
        `<Item type="ReferenceRecord" action="unlock" id="${versioned.getID()}" doGetItem="0" />`,
    );
    expect(
        h.state.getOne("ReferenceRecord", { id: versioned.getID() }).properties.new_version,
    ).toBe(1);
});

test("real C# observes the native version marker after an automatic edit", async () => {
    const source = referenceMethod(
        "InspectVersionMarker",
        `
        var item = this.newItem("ReferenceRecord", "edit");
        item.setID(this.getProperty("record"));
        item.setProperty("name", "Saved by source");
        var saved = item.apply();
        if (saved.isError()) { return saved; }
        if (saved.getProperty("new_version") != "0") {
            throw new Exception("An unlocked automatic generation must have new_version=0");
        }
        return saved;
    `,
    );
    await using project = await referenceProject(source);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const original = h.state.getOne("ReferenceRecord", { name: "Parent" });
    const saved = await h.callMethod("InspectVersionMarker", { record: original.id });

    expect(saved.getID()).not.toBe(original.id);
    expect(saved.getProperty("new_version")).toBe("0");
    expect(h.executions.at(-1)?.mocks).toEqual([]);
}, 60_000);
