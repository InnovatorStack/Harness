import { expect, test } from "bun:test";

import { AuthorizationMode, createHarness, ExecutionOutcome } from "../src/index.js";
import { classificationProject } from "./helpers/classifications.js";
import { referenceEvent, referenceMethod } from "./helpers/references.js";

test("classification access is checked before a before-version Method can remove the value", async () => {
    const source =
        referenceMethod(
            "StripBeforeVersion",
            'this.removeProperty("classification"); return this;',
        ) + referenceEvent("CLASS_RECORD", "onBeforeVersion", "StripBeforeVersion");
    await using project = await classificationProject(source, { versionable: true });
    using h = await createHarness({
        cwd: project.cwd,
        authorization: AuthorizationMode.Native,
        csharp: {},
    });
    const original = h.state.getOne("ClassificationRecord", { name: "Start" });
    const before = h.state.get("ClassificationRecord");
    const saved = await h.applyAML(
        `<Item type="ClassificationRecord" action="edit" id="${original.id}"><classification>Restricted</classification></Item>`,
    );

    expect(saved.getErrorCode()).toBe("PermissionDenied");
    expect(h.state.get("ClassificationRecord")).toEqual(before);
    expect(h.trace.filter((event) => event.name === "StripBeforeVersion")).toEqual([]);
    expect(h.executions.at(-1)?.changes.some((change) => change.name === "version")).toBe(false);
});

test("every selected target needs Update rights before the first update hook runs", async () => {
    const source =
        referenceMethod(
            "UnexpectedUpdate",
            'throw new Exception("Update hook ran before access checks");',
        ) + referenceEvent("CLASS_RECORD", "onBeforeUpdate", "UnexpectedUpdate");
    const fixtures = `ClassificationRecord: [
        { name: "Editable", classification: "Design/Mechanical", permission_id: { name: "SEC_EDIT" } },
        { name: "Read only", classification: "Design/Mechanical", permission_id: { name: "SEC_READ" } },
    ],`;
    await using project = await classificationProject(source, { versionable: true, fixtures });
    using h = await createHarness({
        cwd: project.cwd,
        authorization: AuthorizationMode.Native,
        csharp: {},
    });
    const before = h.state.get("ClassificationRecord");
    const saved = await h.applyAML(
        `<Item type="ClassificationRecord" action="edit" where="name IN ('Editable', 'Read only')"><name>Rejected</name></Item>`,
    );

    expect(saved.getErrorCode()).toBe("PermissionDenied");
    expect(h.trace.filter((event) => event.name === "UnexpectedUpdate")).toEqual([]);
    expect(h.state.get("ClassificationRecord")).toEqual(before);
});

test("the second before-update pass rechecks a class changed by the real Method", async () => {
    const source =
        referenceMethod(
            "RedirectDuringReentry",
            `
            if (!String.IsNullOrEmpty(this.getAttribute("oldId"))) {
                this.setProperty("classification", "Restricted");
            }
            return this;
        `,
        ) + referenceEvent("CLASS_RECORD", "onBeforeUpdate", "RedirectDuringReentry");
    await using project = await classificationProject(source, { versionable: true });
    using h = await createHarness({
        cwd: project.cwd,
        authorization: AuthorizationMode.Native,
        csharp: {},
    });
    const original = h.state.getOne("ClassificationRecord", { name: "Start" });
    const before = h.state.get("ClassificationRecord");
    const saved = await h.applyAML(
        `<Item type="ClassificationRecord" action="edit" id="${original.id}"><classification>Design/Electrical</classification></Item>`,
    );

    expect(saved.getErrorCode()).toBe("PermissionDenied");
    expect(
        h.trace.filter(
            (event) => event.kind === "method" && event.name === "RedirectDuringReentry",
        ),
    ).toHaveLength(2);
    expect(h.state.get("ClassificationRecord")).toEqual(before);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
    expect(h.executions.at(-1)?.changes.some((change) => change.name === "version")).toBe(true);
}, 60_000);

test("an in-place class update validates the entry state before its hook's nested promotion", async () => {
    const source =
        referenceMethod(
            "PromoteBeforeSave",
            `
            var promotion = this.newItem(this.getType(), "promoteItem");
            promotion.setID(this.getID());
            promotion.setProperty("state", "Design review");
            var promoted = promotion.apply();
            if (promoted.isError()) { return promoted; }
            return this;
        `,
        ) + referenceEvent("CLASS_RECORD", "onBeforeUpdate", "PromoteBeforeSave");
    await using project = await classificationProject(source, { versionable: true });
    using h = await createHarness({
        cwd: project.cwd,
        authorization: AuthorizationMode.Native,
        csharp: {},
    });
    const original = h.state.getOne("ClassificationRecord", { name: "Start" });
    const saved = await h.applyAML(
        `<Item type="ClassificationRecord" action="edit" version="0" id="${original.id}"><classification>Operations</classification></Item>`,
    );

    expect(saved.isError()).toBe(false);
    expect(saved.getID()).toBe(original.id);
    expect(h.state.getOne("ClassificationRecord", { id: original.id }).properties).toMatchObject({
        classification: "Operations",
        state: "Operations draft",
        generation: 1,
    });
    expect(h.executions.at(-1)?.changes.some((change) => change.name === "promote")).toBe(true);
}, 60_000);

test("version reentry validates lifecycle changes made after the clone was inserted", async () => {
    const source =
        referenceMethod(
            "AdvanceGeneratedState",
            `
            var promotion = this.newItem(this.getType(), "promoteItem");
            promotion.setID(this.getID());
            promotion.setProperty("state", "Design review");
            var promoted = promotion.apply();
            if (promoted.isError()) { return promoted; }
            return this;
        `,
        ) + referenceEvent("CLASS_RECORD", "onAfterVersion", "AdvanceGeneratedState");
    await using project = await classificationProject(source, { versionable: true });
    using h = await createHarness({
        cwd: project.cwd,
        authorization: AuthorizationMode.Native,
        csharp: {},
    });
    const original = h.state.getOne("ClassificationRecord", { name: "Start" });
    const before = h.state.get("ClassificationRecord");
    const saved = await h.applyAML(
        `<Item type="ClassificationRecord" action="edit" id="${original.id}"><classification>Operations</classification></Item>`,
    );

    expect(saved.getErrorCode()).toBe("ClassificationCannotBeChanged");
    expect(h.state.get("ClassificationRecord")).toEqual(before);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
    expect(h.executions.at(-1)?.changes.some((change) => change.name === "version")).toBe(true);
}, 60_000);

test("version hooks that remove Update rights prevent reentry and roll back the lifecycle", async () => {
    const statePermission = `<Item type="Life Cycle State" action="edit" id="CLASS_DESIGN_REVIEW">
        <state_permission_id>SEC_READ</state_permission_id></Item>`;
    const source =
        statePermission +
        referenceMethod("ObserveSecuredUpdate", "return this;") +
        referenceEvent("CLASS_RECORD", "onBeforeUpdate", "ObserveSecuredUpdate") +
        referenceMethod(
            "RestrictVersion",
            `
            var promotion = this.newItem(this.getType(), "promoteItem");
            promotion.setID(this.getID());
            promotion.setProperty("state", "Design review");
            var promoted = promotion.apply();
            if (promoted.isError()) { return promoted; }
            return this;
        `,
        ) +
        referenceEvent("CLASS_RECORD", "onAfterVersion", "RestrictVersion");
    await using project = await classificationProject(source, { versionable: true });
    using h = await createHarness({
        cwd: project.cwd,
        authorization: AuthorizationMode.Native,
        csharp: {},
    });
    const original = h.state.getOne("ClassificationRecord", { name: "Start" });
    const before = h.state.get("ClassificationRecord");
    const links = h.state.get("ClassificationLink");
    const saved = await h.applyAML(
        `<Item type="ClassificationRecord" action="edit" id="${original.id}"><name>Rejected</name></Item>`,
    );

    expect(saved.getErrorCode()).toBe("PermissionDenied");
    expect(
        h.trace.filter((event) => event.kind === "method" && event.name === "ObserveSecuredUpdate"),
    ).toHaveLength(1);
    expect(
        h.trace.filter((event) => event.kind === "method" && event.name === "RestrictVersion"),
    ).toHaveLength(1);
    expect(h.state.get("ClassificationRecord")).toEqual(before);
    expect(h.state.get("ClassificationLink")).toEqual(links);
    expect(h.executions.at(-1)?.changes.some((change) => change.name === "promote")).toBe(true);
}, 60_000);
