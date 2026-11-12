import { expect, test } from "bun:test";

import { createHarness, ExecutionOutcome } from "../src/index.js";
import { referenceEvent, referenceMethod } from "./helpers/references.js";
import { dependentUnlockProject } from "./helpers/unlock-dependents.js";

test("historical unlocks visit owned dependent descendants before the parent's after hook", async () => {
    await using project = await dependentUnlockProject();
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const parent = h.state.getOne("ReferenceRecord", { name: "First locked source" });
    const child = h.state.getOne("UnlockChild", { name: "Owned child" });
    const leaf = h.state.getOne("UnlockLeaf", { name: "Nested leaf" });
    const other = h.state.getOne("UnlockChild", { name: "Other owner's child" });
    const regular = h.state.getOne("UnlockRegular", { name: "Regular child" });
    const saved = await h.applyAML(
        `<Item type="ReferenceRecord" action="version" id="${parent.id}" />`,
    );

    expect(saved.isError()).toBe(false);
    expect(
        h.trace
            .filter((event) => event.kind === "action" && event.name === "UnlockAudit.add")
            .map((event) => ({
                phase: event.request?.items[0]?.properties.phase,
                id: event.request?.items[0]?.properties.record_id,
            })),
    ).toEqual([
        { phase: "Before", id: parent.id },
        { phase: "Before", id: child.id },
        { phase: "Before", id: leaf.id },
        { phase: "After", id: leaf.id },
        { phase: "After", id: child.id },
        { phase: "After", id: parent.id },
    ]);
    expect(h.state.getOne("UnlockChild", { id: child.id }).properties).toMatchObject({
        locked_by_id: null,
        new_version: 0,
        generation: 1,
    });
    expect(h.state.getOne("UnlockLeaf", { id: leaf.id }).properties.locked_by_id).toBeNull();
    expect(h.state.getOne("UnlockChild", { id: other.id })).toEqual(other);
    expect(h.state.getOne("UnlockRegular", { id: regular.id })).toEqual(regular);
    expect(saved.node.properties.locked_by_id).toBe(parent.properties.locked_by_id);
    expect(h.executions.at(-1)?.mocks).toEqual([]);
}, 60_000);

test("a dependent unlock rejection rolls back every source, descendant and generation", async () => {
    const source =
        referenceMethod(
            "RejectDependentUnlock",
            'return this.getInnovator().newError("Reject dependent unlock");',
        ) + referenceEvent("UNLOCK_LEAF", "onAfterUnlock", "RejectDependentUnlock", { order: 10 });
    await using project = await dependentUnlockProject(source);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const parent = h.state.getOne("ReferenceRecord", { name: "First locked source" });
    const parents = h.state.get("ReferenceRecord");
    const children = h.state.get("UnlockChild");
    const leaves = h.state.get("UnlockLeaf");
    const saved = await h.applyAML(
        `<Item type="ReferenceRecord" action="version" id="${parent.id}" />`,
    );

    expect(saved.getErrorString()).toBe("Reject dependent unlock");
    expect(h.state.get("ReferenceRecord")).toEqual(parents);
    expect(h.state.get("UnlockChild")).toEqual(children);
    expect(h.state.get("UnlockLeaf")).toEqual(leaves);
    expect(h.state.get("UnlockAudit")).toEqual([]);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
}, 60_000);
