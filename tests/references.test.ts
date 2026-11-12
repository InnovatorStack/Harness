import { expect, test } from "bun:test";

import { createHarness, ExecutionOutcome } from "../src/index.js";
import {
    referenceEvent,
    referenceLifecycle,
    referenceMethod,
    referenceProject,
} from "./helpers/references.js";

test("fixed and floating item properties follow imported metadata when the target versions", async () => {
    await using project = await referenceProject();
    using h = await createHarness({ cwd: project.cwd });
    const parent = await h.getOne("ReferenceRecord", { name: "Parent" });
    const child = await h.getOne("ReferenceRecord", { name: "Child" });
    const prepared = await h.update(parent, { fixed_ref: child.id, float_ref: child.id });
    const next = await h.update(child, { name: "Child after edit" });
    const stored = await h.getOne("ReferenceRecord", { id: prepared.id });

    expect(stored.properties.fixed_ref).toBe(child.id);
    expect(stored.properties.float_ref).toBe(next.id);
    expect(h.executions.at(-2)?.changes.some((change) => change.after?.id === prepared.id)).toBe(
        true,
    );
});

test("relationship defaults float current parents while historical relationships freeze", async () => {
    await using project = await referenceProject();
    using h = await createHarness({ cwd: project.cwd });
    const parent = await h.getOne("ReferenceRecord", { name: "Parent" });
    const child = await h.getOne("ReferenceRecord", { name: "Child" });
    const original = await h.add("ReferenceFloat", { source_id: parent.id, related_id: child.id });
    const currentParent = await h.update(parent, { name: "Parent after edit" });
    const nextChild = await h.update(child, { name: "Child after edit" });
    const historical = await h.getOne("ReferenceFloat", { id: original.id });
    const copied = await h.getOne("ReferenceFloat", { source_id: currentParent.id });

    expect(historical.properties).toMatchObject({ related_id: child.id, behavior: "hard_fixed" });
    expect(copied.properties).toMatchObject({ related_id: nextChild.id, behavior: "float" });
});

test("a new parent generation takes the latest related generation without rewriting the old fixed link", async () => {
    await using project = await referenceProject();
    using h = await createHarness({ cwd: project.cwd });
    const parent = await h.getOne("ReferenceRecord", { name: "Parent" });
    const child = await h.getOne("ReferenceRecord", { name: "Child" });
    const original = await h.add("ReferenceFixed", { source_id: parent.id, related_id: child.id });
    const nextChild = await h.update(child, { name: "Child after edit" });
    expect((await h.getOne("ReferenceFixed", { id: original.id })).properties.related_id).toBe(
        child.id,
    );

    const nextParent = await h.update(parent, { name: "Parent after edit" });
    expect(
        (await h.getOne("ReferenceFixed", { source_id: nextParent.id })).properties.related_id,
    ).toBe(nextChild.id);
    expect((await h.getOne("ReferenceFixed", { id: original.id })).properties.related_id).toBe(
        child.id,
    );
});

test("lifecycle behavior overrides soft defaults and hard states latch until the cycle ends", async () => {
    await using project = await referenceProject(referenceLifecycle);
    using h = await createHarness({ cwd: project.cwd });
    const parent = await h.getOne("ReferenceRecord", { name: "Parent" });
    const child = await h.getOne("ReferenceRecord", { name: "Child" });
    const soft = await h.add("ReferenceFixed", { source_id: parent.id, related_id: child.id });
    const hard = await h.add("ReferenceHardFixed", { source_id: parent.id, related_id: child.id });
    const next = await h.update(child, { name: "Child after edit" });
    await h.applyAML(
        `<Item type="ReferenceRecord" action="promoteItem" id="${parent.id}"><state>Floating</state></Item>`,
    );

    expect((await h.getOne("ReferenceFixed", { id: soft.id })).properties.related_id).toBe(next.id);
    expect((await h.getOne("ReferenceHardFixed", { id: hard.id })).properties.related_id).toBe(
        child.id,
    );
    await h.applyAML(
        `<Item type="ReferenceRecord" action="promoteItem" id="${parent.id}"><state>Frozen</state></Item>`,
    );
    await h.applyAML(
        `<Item type="ReferenceRecord" action="promoteItem" id="${parent.id}"><state>Floating</state></Item>`,
    );
    const latest = await h.update(next, { name: "Child again" });

    expect(latest.id).not.toBe(next.id);
    expect((await h.getOne("ReferenceFixed", { id: soft.id })).properties).toMatchObject({
        related_id: next.id,
        behavior: "hard_fixed",
    });
});

test("failed source hooks roll back generations and automatically floated references together", async () => {
    const method = referenceMethod(
        "RejectVersion",
        'return this.getInnovator().newError("Rejected version");',
    );
    await using project = await referenceProject(
        `${method}${referenceEvent("REF_RECORD", "onAfterUpdate", "RejectVersion")}`,
    );
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const parent = await h.getOne("ReferenceRecord", { name: "Parent" });
    const child = await h.getOne("ReferenceRecord", { name: "Child" });
    const link = await h.add("ReferenceFloat", { source_id: parent.id, related_id: child.id });
    await expect(h.update(child, { name: "Rejected" })).rejects.toThrow("Rejected version");

    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
    expect((await h.getOne("ReferenceFloat", { id: link.id })).properties.related_id).toBe(
        child.id,
    );
    expect((await h.get("ReferenceRecord", { config_id: child.id })).length).toBe(1);
}, 60_000);

test("historical item-property references remain stable and resetting restores the original reference graph", async () => {
    const fixtures = `ReferenceFloat: [{ source_id: { name: "Parent" }, related_id: { name: "Child" } }]`;
    await using project = await referenceProject("", fixtures);
    using h = await createHarness({ cwd: project.cwd });
    const parent = await h.getOne("ReferenceRecord", { name: "Parent" });
    const child = await h.getOne("ReferenceRecord", { name: "Child" });
    const prepared = await h.update(parent, { float_ref: child.id });
    const current = await h.update(prepared, { name: "Current parent" });
    const nextChild = await h.update(child, { name: "Current child" });

    expect((await h.getOne("ReferenceRecord", { id: prepared.id })).properties.float_ref).toBe(
        child.id,
    );
    expect((await h.getOne("ReferenceRecord", { id: current.id })).properties.float_ref).toBe(
        nextChild.id,
    );
    h.reset();
    expect(h.state.getOne("ReferenceFloat", { source_id: parent.id }).properties.related_id).toBe(
        child.id,
    );
    expect((await h.getOne("ReferenceRecord", { id: child.id })).properties.generation).toBe(1);
});

test("original C# reads observe floated relationships through the normal expanded query path", async () => {
    const source = referenceMethod(
        "ReadRelated",
        `
        var query = this.newItem("ReferenceFloat", "get");
        query.setProperty("source_id", this.getProperty("parent"));
        query.setAttribute("select", "related_id(name,generation)");
        var result = query.apply();
        if (result.isError()) return result;
        return result.getPropertyItem("related_id");
    `,
    );
    await using project = await referenceProject(source);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const parent = await h.getOne("ReferenceRecord", { name: "Parent" });
    const child = await h.getOne("ReferenceRecord", { name: "Child" });
    await h.add("ReferenceFloat", { source_id: parent.id, related_id: child.id });
    const next = await h.update(child, { name: "New child" });
    const result = await h.callMethod("ReadRelated", { parent: parent.id });

    expect(result.getID()).toBe(next.id);
    expect(result.getProperty("name")).toBe("New child");
    expect(result.getProperty("generation")).toBe("2");
}, 60_000);

test("floating references recover from an older generation in their target family", async () => {
    await using project = await referenceProject();
    using h = await createHarness({ cwd: project.cwd });
    const parent = await h.getOne("ReferenceRecord", { name: "Parent" });
    const original = await h.getOne("ReferenceRecord", { name: "Child" });
    const second = await h.update(original, { name: "Second child" });
    const link = await h.add("ReferenceFloat", { source_id: parent.id, related_id: original.id });
    const third = await h.update(second, { name: "Third child" });

    expect((await h.getOne("ReferenceFloat", { id: link.id })).properties.related_id).toBe(
        third.id,
    );
});
