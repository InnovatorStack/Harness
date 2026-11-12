import { expect, test } from "bun:test";

import { CapabilityId, createHarness, ExecutionOutcome } from "../src/index.js";
import { editLockSources } from "./helpers/edit-pipeline.js";
import { generatedUpdateSources } from "./helpers/generated-updates.js";
import { referenceEvent, referenceMethod, referenceProject } from "./helpers/references.js";

test("implicit edit locks run as a shared batch before replacement without altering pending data", async () => {
    await using project = await referenceProject(editLockSources + generatedUpdateSources(true));
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const parent = h.state.getOne("ReferenceRecord", { name: "Parent" });
    const child = h.state.getOne("ReferenceRecord", { name: "Child" });
    const result = await h.applyAML(
        `<Item type="ReferenceRecord" action="edit" idlist="${parent.id},${child.id}" serverEvents="0"><name>Saved</name></Item>`,
    );

    expect(result.isError()).toBe(false);
    expect(result.payload.items.every((item) => item.properties.name === "Saved")).toBe(true);
    const audits = h.state.get("EditAudit");
    expect(audits.filter((record) => record.properties.phase === "before")).toHaveLength(2);
    expect(audits.filter((record) => record.properties.phase === "after")).toHaveLength(2);

    for (const audit of audits) {
        expect(audit.properties).toMatchObject({
            request_action: "edit",
            do_get_item: "0",
            locked_count: audit.properties.phase === "before" ? 0 : 2,
        });
    }

    expect(
        audits
            .map((record) => record.properties.pending_name)
            .sort((left, right) => String(left).localeCompare(String(right))),
    ).toEqual(["Saved", "Saved/lock", "Saved/lock/lock", "Saved/lock/lock"]);
    expect(h.trace.filter((event) => event.kind === "method").map((event) => event.name)).toEqual([
        "BeforeEditLock",
        "BeforeEditLock",
        "AfterEditLock",
        "AfterEditLock",
        "ReplaceUpdate",
        "ReplaceUpdate",
    ]);
}, 60_000);

test("text-only versionable edit replacements report their unsupported response and roll back", async () => {
    await using project = await referenceProject(generatedUpdateSources());
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const parent = h.state.getOne("ReferenceRecord", { name: "Parent" });
    const baseline = h.state.get("ReferenceRecord");

    await expect(
        h.applyAML(
            `<Item type="ReferenceRecord" action="edit" id="${parent.id}"><name>Skip generated update</name></Item>`,
        ),
    ).rejects.toMatchObject({
        code: "UnsupportedEditResult",
        capability: CapabilityId.ItemActions,
    });
    expect(h.state.get("ReferenceRecord")).toEqual(baseline);
    expect(h.state.get("ReplacementAudit")).toEqual([]);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
}, 60_000);

test("an already-owned lock skips implicit locking for the entire edit batch", async () => {
    await using project = await referenceProject(editLockSources);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const parent = h.state.getOne("ReferenceRecord", { name: "Parent" });
    const child = h.state.getOne("ReferenceRecord", { name: "Child" });
    await h.applyAML(
        `<Item type="ReferenceRecord" action="lock" id="${parent.id}" serverEvents="0" />`,
    );
    const baseline = h.state.get("ReferenceRecord");

    await expect(
        h.applyAML(
            `<Item type="ReferenceRecord" action="edit" idlist="${child.id},${parent.id}" />`,
        ),
    ).rejects.toMatchObject({ code: "LockOwnership" });
    expect(h.state.get("ReferenceRecord")).toEqual(baseline);
    expect(h.state.get("EditAudit")).toEqual([]);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
});

test.each([false, true])(
    "edit wrappers unlock replacement-returned Items and fetch stored values: generated=%s",
    async (generated) => {
        const code = `// MethodTemplateName = CSharpInOut;
            var input = inDom.DocumentElement ?? throw new Exception("Missing input");
            bool isGenerated = !String.IsNullOrEmpty(input.GetAttribute("oldId"));
            if (${generated ? "isGenerated" : "!isGenerated"}) {
                outDom.LoadXml("<Result>" + input.OuterXml + "</Result>");
                return;
            }
            eventData.BaseUpdateItem(outDom);
        `;
        const unexpected =
            referenceMethod(
                "UnexpectedSave",
                'throw new Exception("Skipped save must not execute");',
            ) + referenceEvent("REF_RECORD", "onAfterUpdate", "UnexpectedSave");
        await using project = await referenceProject(
            generatedUpdateSources(false, code) + unexpected,
        );
        using h = await createHarness({ cwd: project.cwd, csharp: {} });
        const parent = h.state.getOne("ReferenceRecord", { name: "Parent" });
        const result = await h.applyAML(
            `<Item type="ReferenceRecord" action="edit" id="${parent.id}"><name>Pending only</name></Item>`,
        );

        expect(result.isError()).toBe(false);
        expect(result.node.properties).toMatchObject({
            name: "Parent",
            generation: generated ? 2 : 1,
            locked_by_id: null,
            new_version: 0,
        });
        expect(result.getID() === parent.id).toBe(!generated);
        expect(h.trace.some((event) => event.name === "UnexpectedSave")).toBe(false);
        expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.Committed);
    },
    60_000,
);

test("a rejecting final edit unlock hook rolls back the generated update and both lock phases", async () => {
    const source =
        editLockSources +
        referenceMethod(
            "RejectFinalUnlock",
            `
            if (this.getProperty("name") == "Reject final unlock") {
                return this.getInnovator().newError("Final unlock rejected");
            }
            return this;
        `,
        ) +
        referenceEvent("REF_RECORD", "onAfterUnlock", "RejectFinalUnlock");
    await using project = await referenceProject(source);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const parent = h.state.getOne("ReferenceRecord", { name: "Parent" });
    const baseline = h.state.get("ReferenceRecord");
    const result = await h.applyAML(
        `<Item type="ReferenceRecord" action="edit" id="${parent.id}"><name>Reject final unlock</name></Item>`,
    );

    expect(result.getErrorString()).toBe("Final unlock rejected");
    expect(h.state.get("ReferenceRecord")).toEqual(baseline);
    expect(h.state.get("EditAudit")).toEqual([]);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
    expect(h.executions.at(-1)?.changes.some((change) => change.name === "version")).toBe(true);
    expect(h.executions.at(-1)?.changes.some((change) => change.name === "update")).toBe(true);
}, 60_000);
