import { expect, test } from "bun:test";

import { createHarness, ExecutionOutcome } from "../src/index.js";
import { referenceEvent, referenceMethod, referenceProject } from "./helpers/references.js";
import { updateEventSources } from "./helpers/update-events.js";

test("real source sees the original update, version request and generated update in order", async () => {
    await using project = await referenceProject(updateEventSources);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const original = await h.add("ReferenceRecord", { name: "Original" });
    const saved = await h.update(original, { name: "Change preflight" });
    expect(h.trace.filter((event) => event.kind === "method").map((event) => event.name)).toEqual([
        "ObserveUpdate",
        "ObserveVersion",
        "ObserveUpdate",
    ]);
    expect(h.state.getOne("UpdateAudit", { phase: "preflight" }).properties).toMatchObject({
        record_id: original.id,
        request_action: "edit",
        old_id: "",
        pending_name: "Change preflight",
        stored_name: "Original",
        pending_marker: "",
        stored_marker: "0",
    });
    expect(h.state.getOne("UpdateAudit", { phase: "version" }).properties).toMatchObject({
        record_id: original.id,
        request_action: "version",
        pending_name: "Change preflight",
        stored_name: "Original",
        current_marker: "0",
    });
    expect(h.state.getOne("UpdateAudit", { phase: "reentry" }).properties).toMatchObject({
        record_id: saved.id,
        old_id: original.id,
        request_action: "version",
        pending_name: "Change preflight",
        stored_name: "Original",
        pending_marker: "1",
        stored_marker: "0",
    });
    expect(saved.properties).toMatchObject({ name: "Change preflight", generation: 2 });
    expect(h.state.getOne("ReferenceRecord", { id: original.id }).properties.name).toBe("Original");
    expect(h.executions.at(-1)?.mocks).toEqual([]);
}, 60_000);

test("a real before-update Method can suppress automatic versioning and save its changed input", async () => {
    await using project = await referenceProject(updateEventSources);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const original = await h.getOne("ReferenceRecord", { name: "Parent" });
    const saved = await h.update(original, { name: "Suppress generation" });

    expect(saved.id).toBe(original.id);
    expect(saved.properties).toMatchObject({ name: "Saved in place", generation: 1 });
    expect(h.state.get("ReferenceRecord", { config_id: original.id })).toHaveLength(1);
    expect(h.state.get("UpdateAudit").map((audit) => audit.properties.phase)).toEqual([
        "preflight",
    ]);
    expect(h.executions.at(-1)?.changes.some((change) => change.name === "version")).toBe(false);
}, 60_000);

test("explicit version enters the update phase once after version hooks", async () => {
    await using project = await referenceProject(updateEventSources);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const original = h.state.getOne("ReferenceRecord", { name: "Parent" });
    const saved = await h.applyAML(
        `<Item type="ReferenceRecord" action="version" id="${original.id}"><name>Explicit</name></Item>`,
    );

    expect(saved.isError()).toBe(false);
    expect(saved.getID()).not.toBe(original.id);
    expect(h.trace.filter((event) => event.kind === "method").map((event) => event.name)).toEqual([
        "ObserveVersion",
        "ObserveUpdate",
    ]);
    expect(h.state.getOne("UpdateAudit", { phase: "reentry" }).properties).toMatchObject({
        request_action: "version",
        old_id: original.id,
        pending_marker: "1",
    });
}, 60_000);

test("manual saves run their before-update Method once and keep the generation", async () => {
    const manual = `<Item type="ItemType" action="edit" id="REF_RECORD">
        <manual_versioning>1</manual_versioning></Item>`;
    await using project = await referenceProject(updateEventSources + manual);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const original = await h.getOne("ReferenceRecord", { name: "Parent" });
    const saved = await h.update(original, { name: "Manual save" });

    expect(saved.id).toBe(original.id);
    expect(h.state.get("UpdateAudit")).toHaveLength(1);
    expect(h.state.getOne("UpdateAudit", {}).properties).toMatchObject({
        phase: "preflight",
        request_action: "edit",
    });
}, 60_000);

test.each([
    ["Reject preflight", "Rejected before versioning", false],
    ["Reject reentry", "Rejected after versioning", true],
])(
    "%s rolls back source writes, locks and any generations",
    async (name, message, versioned) => {
        await using project = await referenceProject(updateEventSources);
        using h = await createHarness({ cwd: project.cwd, csharp: {} });
        const original = h.state.getOne("ReferenceRecord", { name: "Parent" });
        const records = h.state.get("ReferenceRecord");
        const saved = await h.applyAML(
            `<Item type="ReferenceRecord" action="edit" id="${original.id}"><name>${name}</name></Item>`,
        );

        expect(saved.getErrorString()).toBe(message);
        expect(h.state.get("ReferenceRecord")).toEqual(records);
        expect(h.state.get("UpdateAudit")).toEqual([]);
        expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
        expect(h.executions.at(-1)?.changes.some((change) => change.name === "version")).toBe(
            versioned,
        );
    },
    60_000,
);

test("required update hooks run on both passes while optional version hooks still execute", async () => {
    const optional =
        referenceMethod("OptionalUpdate", 'throw new Exception("Optional update hook ran");') +
        referenceEvent("REF_RECORD", "onBeforeUpdate", "OptionalUpdate", { order: 10 });
    await using project = await referenceProject(updateEventSources + optional);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const original = h.state.getOne("ReferenceRecord", { name: "Parent" });
    const saved = await h.applyAML(
        `<Item type="ReferenceRecord" action="edit" serverEvents="0" id="${original.id}"><name>Saved</name></Item>`,
    );

    expect(saved.isError()).toBe(false);
    expect(h.trace.filter((event) => event.kind === "method").map((event) => event.name)).toEqual([
        "ObserveUpdate",
        "ObserveVersion",
        "ObserveUpdate",
    ]);
    expect(h.state.getOne("ReferenceRecord", { id: saved.getID() }).properties.name).toBe("Saved");
}, 60_000);

test("reset removes both update passes and restores the original generation and locks", async () => {
    await using project = await referenceProject(updateEventSources);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const original = await h.getOne("ReferenceRecord", { name: "Parent" });
    const baseline = h.state.get("ReferenceRecord");
    await h.update(original, { name: "Saved" });

    expect(h.state.get("UpdateAudit")).toHaveLength(3);
    h.reset();
    expect(h.state.get("ReferenceRecord")).toEqual(baseline);
    expect(h.state.get("UpdateAudit")).toEqual([]);
    expect(h.executions).toEqual([]);
    const saved = await h.update(await h.getOne("ReferenceRecord", { name: "Parent" }), {
        name: "Saved again",
    });

    expect(saved.properties.generation).toBe(2);
    expect(h.state.get("UpdateAudit")).toHaveLength(3);
}, 60_000);

test("a before-update source Method can acquire the required lock before validation", async () => {
    const source =
        referenceMethod(
            "AcquireUpdateLock",
            `
            if (String.IsNullOrEmpty(this.getAttribute("oldId"))) {
                var request = this.newItem(this.getType(), "lock");
                request.setID(this.getID());
                request.setAttribute("doGetItem", "0");
                var result = request.apply();
                if (result.isError()) { return result; }
            }
            return this;
        `,
        ) + referenceEvent("REF_RECORD", "onBeforeUpdate", "AcquireUpdateLock", { order: -10 });
    await using project = await referenceProject(updateEventSources + source);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const original = h.state.getOne("ReferenceRecord", { name: "Parent" });
    const saved = await h.applyAML(
        `<Item type="ReferenceRecord" action="update" id="${original.id}"><name>Saved from unlocked</name></Item>`,
    );

    expect(saved.isError()).toBe(false);
    expect(saved.getID()).not.toBe(original.id);
    expect(saved.node.properties).toMatchObject({ generation: 2, name: "Saved from unlocked" });
    expect(saved.node.properties.locked_by_id).toBeTruthy();
    expect(h.state.get("UpdateAudit", { phase: "reentry" })).toHaveLength(1);
}, 60_000);

test("a before-update rejection precedes missing-lock validation and rolls back its writes", async () => {
    await using project = await referenceProject(updateEventSources);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const original = h.state.getOne("ReferenceRecord", { name: "Parent" });
    const baseline = h.state.get("ReferenceRecord");
    const result = await h.applyAML(
        `<Item type="ReferenceRecord" action="update" id="${original.id}"><name>Reject preflight</name></Item>`,
    );

    expect(result.getErrorString()).toBe("Rejected before versioning");
    expect(h.state.get("ReferenceRecord")).toEqual(baseline);
    expect(h.state.get("UpdateAudit")).toEqual([]);
    expect(
        h.trace.filter((event) => event.kind === "method" && event.name === "ObserveUpdate"),
    ).toHaveLength(1);
}, 60_000);
