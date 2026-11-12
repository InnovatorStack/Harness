import { expect, test } from "bun:test";

import {
    CapabilityId,
    checkCompatibility,
    createHarness,
    ExecutionOutcome,
    seededIds,
} from "../src/index.js";
import {
    checkCopiedLifecycleSource,
    classifiedCopy,
    copyDetailFixtures,
    copyDetails,
    copyFixtures,
    copyLifecycle,
} from "./helpers/copy-lifecycle.js";
import { referenceEvent, referenceMethod, referenceProject } from "./helpers/references.js";

const profiles = [
    { versionable: false, manual: false, marker: 1 },
    { versionable: true, manual: false, marker: 0 },
    { versionable: true, manual: true, marker: 1 },
];

test.each(profiles)(
    "copies initialize their lifecycle without changing source history: %j",
    async (profile) => {
        const schema = `<Item type="ItemType" action="edit" id="ReferenceFixed">
        <is_versionable>${profile.versionable ? 1 : 0}</is_versionable>
        <manual_versioning>${profile.manual ? 1 : 0}</manual_versioning></Item>`;
        await using project = await referenceProject(copyLifecycle + schema, copyFixtures);
        using h = await createHarness({ cwd: project.cwd });
        const parent = await h.getOne("ReferenceRecord", { name: "Parent" });
        const source = h.state.getOne("ReferenceFixed", { source_id: parent.id });
        const next = await h.update(parent, { name: "Saved" });
        const copied = h.state.getOne("ReferenceFixed", { source_id: next.id });

        expect(copied.properties).toMatchObject({
            config_id: copied.id,
            generation: 1,
            new_version: profile.marker,
            state: "Draft",
            current_state: "COPY_DRAFT",
            is_released: 0,
            not_lockable: 0,
            permission_id: "COPY_DRAFT_PERMISSION",
            sort_order: 7,
            locked_by_id: null,
        });
        expect(h.state.getOne("ReferenceFixed", { id: source.id }).properties).toEqual({
            ...source.properties,
            behavior: "hard_fixed",
        });
        expect(
            h.executions.at(-1)?.changes.filter((change) => change.name === "reset-lifecycle"),
        ).toHaveLength(1);
    },
);

test("copy defaults select the most specific classification binding", async () => {
    const fixtures = copyFixtures.replace(
        "sort_order: 7,",
        'sort_order: 7, classification: "Special/Detail",',
    );
    await using project = await referenceProject(copyLifecycle + classifiedCopy, fixtures);
    using h = await createHarness({ cwd: project.cwd });
    const parent = await h.getOne("ReferenceRecord", { name: "Parent" });
    const source = h.state.getOne("ReferenceFixed", { source_id: parent.id });
    const next = await h.update(parent, { name: "Saved" });
    const copied = h.state.getOne("ReferenceFixed", { source_id: next.id });

    expect(copied.properties).toMatchObject({
        classification: "Special/Detail",
        current_state: "COPY_SPECIAL_DRAFT",
        state: "Prototype",
        not_lockable: 0,
        permission_id: "COPY_DRAFT_PERMISSION",
    });
    expect(source.properties.current_state).toBe("COPY_SPECIAL_WORKING");
    expect(h.state.getOne("ReferenceFixed", { id: source.id }).properties.state).toBe("Working");
});

test("copies without a default map clear state flags and retain their stored permission", async () => {
    const fixtures = `ReferenceFixed: [{ source_id: { name: "Parent" },
        related_id: { name: "Child" }, state: "Old state", current_state: "OLD_STATE",
        is_released: 0, not_lockable: 1, permission_id: { name: "Copy working" } }],`;
    const unbound =
        '<Item type="ItemType Life Cycle" action="delete" where="source_id = \'ReferenceFixed\'" />';
    await using project = await referenceProject(copyLifecycle + unbound, fixtures);
    using h = await createHarness({ cwd: project.cwd });
    const parent = await h.getOne("ReferenceRecord", { name: "Parent" });
    const next = await h.update(parent, { name: "Saved" });

    expect(h.state.getOne("ReferenceFixed", { source_id: next.id }).properties).toMatchObject({
        current_state: null,
        state: null,
        is_released: 0,
        not_lockable: 0,
        permission_id: "COPY_WORKING_PERMISSION",
    });
    expect(h.state.getOne("ReferenceFixed", { source_id: parent.id }).properties.state).toBe(
        "Old state",
    );
});

test("real after-version Methods see initialized copied states and nested reference policies", async () => {
    const source =
        referenceMethod("CheckCopiedLifecycle", checkCopiedLifecycleSource) +
        referenceEvent("REF_RECORD", "onAfterVersion", "CheckCopiedLifecycle");
    await using project = await referenceProject(
        copyLifecycle + copyDetails + source,
        copyDetailFixtures,
    );
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const parent = await h.getOne("ReferenceRecord", { name: "Parent" });
    const saved = await h.update(parent, { name: "Saved" });
    const copied = h.state.getOne("ReferenceFixed", { source_id: saved.id });

    expect(h.state.getOne("CopyDetail", { source_id: copied.id }).properties.behavior).toBe(
        "hard_float",
    );
    expect(h.state.getOne("Method", { name: "CheckCopiedLifecycle" }).properties.method_code).toBe(
        checkCopiedLifecycleSource,
    );
    expect(h.trace.filter((entry) => entry.kind === "method").map((entry) => entry.name)).toEqual([
        "CheckCopiedLifecycle",
    ]);
    expect(h.executions.at(-1)?.mocks).toEqual([]);
}, 60_000);

test("a real Method rejection rolls back copied states and nested reference changes", async () => {
    const source =
        referenceMethod(
            "RejectCopiedLifecycle",
            checkCopiedLifecycleSource.replace(
                "return this;",
                'return this.getInnovator().newError("Reject initialized copy");',
            ),
        ) + referenceEvent("REF_RECORD", "onAfterVersion", "RejectCopiedLifecycle");
    await using project = await referenceProject(
        copyLifecycle + copyDetails + source,
        copyDetailFixtures,
    );
    const options = { cwd: project.cwd, csharp: {}, ids: seededIds("copy-lifecycle-reset") };
    using h = await createHarness(options);
    using other = await createHarness(options);
    const before = h.state.get("ReferenceRecord");
    const links = h.state.get("ReferenceFixed");
    const details = h.state.get("CopyDetail");
    const parent = await h.getOne("ReferenceRecord", { name: "Parent" });

    await expect(h.update(parent, { name: "Rejected" })).rejects.toThrow("Reject initialized copy");
    expect(h.state.get("ReferenceRecord")).toEqual(before);
    expect(h.state.get("ReferenceFixed")).toEqual(links);
    expect(h.state.get("CopyDetail")).toEqual(details);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
    expect(
        h.executions.at(-1)?.changes.filter((change) => change.name === "reset-lifecycle"),
    ).toHaveLength(2);
    expect(other.state.get("ReferenceFixed")).toEqual(links);
    h.reset();
    expect(h.executions).toEqual([]);
    expect(h.state.get("ReferenceFixed")).toEqual(links);
    expect(other.state.get("CopyDetail")).toEqual(details);
}, 60_000);

test("a copied start state requiring a workflow rolls back the parent version", async () => {
    const workflow = `<Item type="Workflow Map" action="add" id="COPY_WORKFLOW"><name>Copy workflow</name></Item>
        <Item type="Life Cycle State" action="edit" id="COPY_DRAFT"><workflow>COPY_WORKFLOW</workflow></Item>`;
    await using project = await referenceProject(copyLifecycle + workflow, copyFixtures);
    using h = await createHarness({ cwd: project.cwd });
    const before = h.state.get("ReferenceRecord");
    const links = h.state.get("ReferenceFixed");

    await expect(
        h.update(await h.getOne("ReferenceRecord", { name: "Parent" }), { name: "Rejected" }),
    ).rejects.toMatchObject({
        code: "UnsupportedWorkflow",
        capability: CapabilityId.Workflow,
    });
    expect(h.state.get("ReferenceRecord")).toEqual(before);
    expect(h.state.get("ReferenceFixed")).toEqual(links);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
});

test("a released start state requires its date initialization instead of silently copying dates", async () => {
    const schema = `<Item type="ItemType" action="edit" id="ReferenceFixed"><is_versionable>1</is_versionable></Item>
        <Item type="Life Cycle State" action="edit" id="COPY_DRAFT"><set_is_released>1</set_is_released></Item>`;
    await using project = await referenceProject(copyLifecycle + schema, copyFixtures);
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

test.each([false, true])(
    "reset callbacks fail explicitly even when parent events are suppressed; inherited=%s",
    async (inherited) => {
        const owner = inherited ? "COPY_RESET_BASE" : "ReferenceFixed";
        const base = inherited
            ? `<Item type="ItemType" action="add" id="${owner}"><name>ResetBase</name><implementation_type>polymorphic</implementation_type></Item>
        <Item type="Morphae" action="add"><source_id>${owner}</source_id><related_id>ReferenceFixed</related_id></Item>`
            : "";
        const source =
            referenceMethod("ResetCallback", 'throw new Exception("Reset must not be faked");') +
            referenceEvent(owner, "onAfterResetLifecycle", "ResetCallback");
        await using project = await referenceProject(copyLifecycle + base + source, copyFixtures);
        using h = await createHarness({ cwd: project.cwd });
        const parent = await h.getOne("ReferenceRecord", { name: "Parent" });
        const links = h.state.get("ReferenceFixed");

        await expect(
            h.applyAML(
                `<Item type="ReferenceRecord" action="version" id="${parent.id}" serverEvents="0" />`,
            ),
        ).rejects.toMatchObject({
            code: "UnsupportedLifecycleResetEvent",
            capability: CapabilityId.Lifecycles,
        });
        expect(h.state.get("ReferenceFixed")).toEqual(links);
        expect(h.trace.some((entry) => entry.kind === "method")).toBe(false);
        const report = await checkCompatibility({ cwd: project.cwd });
        expect(
            report.issues.some(
                (issue) =>
                    issue.causeCode === "UnsupportedLifecycleResetEvent" &&
                    issue.capability === CapabilityId.Lifecycles &&
                    issue.source !== undefined,
            ),
        ).toBe(true);
    },
);
