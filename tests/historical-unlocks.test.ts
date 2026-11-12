import { expect, test } from "bun:test";

import { createHarness, ExecutionOutcome } from "../src/index.js";
import { referenceEvent, referenceMethod } from "./helpers/references.js";
import { unlockProject } from "./helpers/unlock-events.js";

test.each([false, true])(
    "versioning unlocks the historical source and retains the new lock: manual=%s",
    async (manual) => {
        const metadata = `<Item type="ItemType" action="edit" id="REF_RECORD">
            <manual_versioning>${manual ? 1 : 0}</manual_versioning></Item>`;
        await using project = await unlockProject(metadata);
        using h = await createHarness({ cwd: project.cwd, csharp: {} });
        const original = h.state.getOne("ReferenceRecord", { name: "First locked source" });
        const saved = await h.applyAML(
            `<Item type="ReferenceRecord" action="version" id="${original.id}"><name>New generation</name></Item>`,
        );
        const previous = h.state.getOne("ReferenceRecord", { id: original.id });

        expect(saved.isError()).toBe(false);
        expect(saved.getID()).not.toBe(original.id);
        expect(previous.properties).toMatchObject({
            name: "First locked source",
            is_current: 0,
            locked_by_id: null,
            new_version: manual ? 1 : 0,
        });
        expect(saved.node.properties).toMatchObject({ generation: 2, new_version: 1 });
        expect(saved.node.properties.locked_by_id).toBeTruthy();
        expect(
            h.state.getOne("UnlockAudit", { phase: "Before", record_id: original.id }).properties,
        ).toMatchObject({
            context_name: "First locked source",
            context_marker: "1",
            stored_marker: "1",
        });
        expect(
            h.state.getOne("UnlockAudit", { phase: "After", record_id: original.id }).properties,
        ).toMatchObject({
            stored_owner: "",
            stored_marker: manual ? "1" : "0",
            context_marker: "1",
            pending_note: "Retained across unlock callbacks",
        });
        expect(h.executions.at(-1)?.mocks).toEqual([]);
    },
    60_000,
);

test("all historical before-unlock hooks precede every after-unlock hook in a versioned batch", async () => {
    await using project = await unlockProject();
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const first = h.state.getOne("ReferenceRecord", { name: "First locked source" });
    const second = h.state.getOne("ReferenceRecord", { name: "Second locked source" });
    const saved = await h.applyAML(
        `<Item type="ReferenceRecord" action="version" idlist="${first.id},${second.id}" />`,
    );

    expect(saved.getItemCount()).toBe(2);
    expect(h.trace.filter((event) => event.kind === "method").map((event) => event.name)).toEqual([
        "CaptureUnlockBefore",
        "CaptureUnlockBefore",
        "CaptureUnlockAfter",
        "CaptureUnlockAfter",
    ]);
    expect(
        h.state.getOne("UnlockAudit", { phase: "Before", record_id: second.id }).properties,
    ).toMatchObject({
        context_name: "First locked source",
        pending_note: "Retained across unlock callbacks",
    });
    expect(
        h.state
            .get("UnlockAudit", { phase: "After" })
            .every((audit) => audit.properties.stored_owner === ""),
    ).toBe(true);
    expect(h.state.getOne("ReferenceRecord", { id: first.id }).properties.locked_by_id).toBeNull();
    expect(h.state.getOne("ReferenceRecord", { id: second.id }).properties.locked_by_id).toBeNull();
}, 60_000);

test.each(["Before", "After"])(
    "a rejecting historical %s hook rolls back clones, locks and nested audit writes",
    async (phase) => {
        const source =
            referenceMethod(
                "RejectHistoricalUnlock",
                'return this.getInnovator().newError("Reject historical unlock");',
            ) +
            referenceEvent("REF_RECORD", `on${phase}Unlock`, "RejectHistoricalUnlock", {
                order: 10,
            });
        await using project = await unlockProject(source);
        using h = await createHarness({ cwd: project.cwd, csharp: {} });
        const original = h.state.getOne("ReferenceRecord", { name: "First locked source" });
        const baseline = h.state.get("ReferenceRecord");
        const result = await h.applyAML(
            `<Item type="ReferenceRecord" action="version" id="${original.id}" />`,
        );

        expect(result.getErrorString()).toBe("Reject historical unlock");
        expect(h.state.get("ReferenceRecord")).toEqual(baseline);
        expect(h.state.get("UnlockAudit")).toEqual([]);
        expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
        expect(h.executions.at(-1)?.changes.some((change) => change.name === "version")).toBe(true);
    },
    60_000,
);

test("internal historical unlocks bypass an onUnlock replacement and ignore event suppression", async () => {
    const source =
        referenceMethod(
            "RejectUnlockReplacement",
            'throw new Exception("Internal unlock called a replacement");',
        ) + referenceEvent("REF_RECORD", "onUnlock", "RejectUnlockReplacement");
    await using project = await unlockProject(source);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const original = h.state.getOne("ReferenceRecord", { name: "First locked source" });
    const result = await h.applyAML(
        `<Item type="ReferenceRecord" action="version" id="${original.id}" serverEvents="0" />`,
    );

    expect(result.isError()).toBe(false);
    expect(h.state.get("UnlockAudit")).toHaveLength(2);
    expect(h.trace.some((event) => event.name === "RejectUnlockReplacement")).toBe(false);
    expect(
        h.state.getOne("ReferenceRecord", { id: original.id }).properties.locked_by_id,
    ).toBeNull();
}, 60_000);

test("versioning an unlocked source never runs historical unlock hooks", async () => {
    await using project = await unlockProject();
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const original = h.state.getOne("ReferenceRecord", { name: "Parent" });
    const result = await h.applyAML(
        `<Item type="ReferenceRecord" action="version" id="${original.id}" />`,
    );

    expect(result.isError()).toBe(false);
    expect(h.state.get("UnlockAudit")).toEqual([]);
    expect(
        h.state.getOne("ReferenceRecord", { id: result.getID() }).properties.locked_by_id,
    ).toBeTruthy();
});

test("world reset restores the original locks and removes historical hook writes", async () => {
    await using project = await unlockProject();
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const original = h.state.getOne("ReferenceRecord", { name: "First locked source" });
    const baseline = h.state.get("ReferenceRecord");
    await h.applyAML(`<Item type="ReferenceRecord" action="version" id="${original.id}" />`);

    expect(h.state.get("UnlockAudit")).toHaveLength(2);
    h.reset();
    expect(h.state.get("ReferenceRecord")).toEqual(baseline);
    expect(h.state.get("UnlockAudit")).toEqual([]);
    expect(h.executions).toEqual([]);
}, 60_000);

test("historical hook hydration runs the real Get chain without persisting calculated values", async () => {
    const source =
        referenceMethod(
            "ProjectUnlockName",
            'this.setProperty("name", "Computed: " + this.getProperty("name")); return this;',
        ) + referenceEvent("REF_RECORD", "onAfterGet", "ProjectUnlockName");
    await using project = await unlockProject(source);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const original = h.state.getOne("ReferenceRecord", { name: "First locked source" });
    const saved = await h.applyAML(
        `<Item type="ReferenceRecord" action="version" id="${original.id}"><name>Saved</name></Item>`,
    );

    expect(saved.isError()).toBe(false);
    expect(
        h.state.getOne("UnlockAudit", { phase: "Before", record_id: original.id }).properties
            .context_name,
    ).toBe("Computed: First locked source");
    expect(h.state.getOne("ReferenceRecord", { id: original.id }).properties.name).toBe(
        "First locked source",
    );
    expect(h.state.getOne("ReferenceRecord", { id: saved.getID() }).properties.name).toBe("Saved");
    expect(h.executions.at(-1)?.mocks).toEqual([]);
}, 60_000);

test("historical unlock hooks see all clones before pending values and relationship copies are applied", async () => {
    const source =
        referenceMethod(
            "InspectIntermediateClone",
            `
            var query = this.newItem(this.getType(), "get");
            query.setProperty("config_id", this.getProperty("config_id"));
            query.setProperty("is_current", "1");
            var current = query.apply();
            if (current.isError()) { return current; }
            if (current.getID() == this.getID() ||
                current.getProperty("name") != "First locked source") {
                throw new Exception("The intermediate clone must retain stored business values");
            }

            var links = this.newItem("ReferenceFixed", "get");
            links.setProperty("source_id", current.getID());
            if (links.apply().getItemCount() > 0) {
                throw new Exception("Relationships were copied before the historical unlock");
            }
            return this;
        `,
        ) +
        referenceEvent("REF_RECORD", "onBeforeUnlock", "InspectIntermediateClone", { order: 10 });
    const fixtures = `ReferenceFixed: [{
        source_id: { name: "First locked source" }, related_id: { name: "Child" },
    }],`;
    await using project = await unlockProject(source, fixtures);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const original = h.state.getOne("ReferenceRecord", { name: "First locked source" });
    const saved = await h.applyAML(
        `<Item type="ReferenceRecord" action="version" id="${original.id}"><name>Saved</name></Item>`,
    );

    expect(saved.isError()).toBe(false);
    expect(h.state.get("ReferenceFixed", { source_id: saved.getID() })).toHaveLength(1);
    expect(h.state.getOne("ReferenceRecord", { id: saved.getID() }).properties.name).toBe("Saved");
}, 60_000);
