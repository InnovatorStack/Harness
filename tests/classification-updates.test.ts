import { expect, test } from "bun:test";

import { AuthorizationMode, createHarness, ExecutionOutcome } from "../src/index.js";
import { classificationProject } from "./helpers/classifications.js";
import { referenceEvent, referenceMethod } from "./helpers/references.js";

test.each([false, true])(
    "a map change resets its state and retains history: versionable=%s",
    async (versionable) => {
        await using project = await classificationProject("", { versionable });
        using h = await createHarness({
            cwd: project.cwd,
            authorization: AuthorizationMode.Native,
        });
        const original = await h.getOne("ClassificationRecord", { name: "Start" });
        const changed = await h.update(original, { classification: "Operations", name: "Changed" });

        expect(changed.properties).toMatchObject({
            classification: "Operations",
            state: "Operations draft",
            current_state: "CLASS_OPERATIONS_START",
            is_released: 0,
            not_lockable: 0,
            config_id: original.id,
            generation: versionable ? 2 : 1,
        });
        expect(changed.id === original.id).toBe(!versionable);

        if (versionable) {
            expect(
                h.state.getOne("ClassificationRecord", { id: original.id }).properties,
            ).toMatchObject({
                classification: "Design/Mechanical",
                state: "Design draft",
                is_current: 0,
            });
        }

        expect(
            h.executions.at(-1)?.changes.some((change) => change.name === "set-default-lifecycle"),
        ).toBe(true);
    },
);

test.each([false, true])(
    "same-map class changes preserve a progressed state: versionable=%s",
    async (versionable) => {
        await using project = await classificationProject("", { versionable });
        using h = await createHarness({
            cwd: project.cwd,
            authorization: AuthorizationMode.Native,
        });
        const original = await h.getOne("ClassificationRecord", { name: "Advanced" });
        const changed = await h.update(original, { classification: "Design/Electrical" });

        expect(changed.properties).toMatchObject({
            classification: "Design/Electrical",
            state: "Design review",
            current_state: "CLASS_DESIGN_REVIEW",
        });
        expect(
            h.executions.at(-1)?.changes.some((change) => change.name === "set-default-lifecycle"),
        ).toBe(false);
    },
);

test.each([false, true])(
    "a progressed item cannot switch maps: versionable=%s",
    async (versionable) => {
        await using project = await classificationProject("", { versionable });
        using h = await createHarness({
            cwd: project.cwd,
            authorization: AuthorizationMode.Native,
        });
        const original = await h.getOne("ClassificationRecord", { name: "Advanced" });
        const before = h.state.get("ClassificationRecord");
        const links = h.state.get("ClassificationLink");
        const result = await h.applyAML(
            `<Item type="ClassificationRecord" action="edit" id="${original.id}">
            <classification>Operations</classification><name>Must roll back</name>
        </Item>`,
        );

        expect(result.getErrorCode()).toBe("ClassificationCannotBeChanged");
        expect(h.state.get("ClassificationRecord")).toEqual(before);
        expect(h.state.get("ClassificationLink")).toEqual(links);
        expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
    },
);

test("a class change can remove and restore its lifecycle while retaining unrelated fields", async () => {
    await using project = await classificationProject();
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });
    const original = await h.getOne("ClassificationRecord", { name: "Start" });
    const cleared = await h.update(original, { classification: "Plain", name: "Retained" });

    expect(cleared.properties).toMatchObject({
        classification: "Plain",
        state: null,
        current_state: null,
        is_released: 0,
        not_lockable: 0,
    });
    const restored = await h.update(cleared, { classification: "Operations" });

    expect(restored.properties).toMatchObject({ name: "Retained", state: "Operations draft" });
    h.reset();
    expect(h.state.getOne("ClassificationRecord", { id: original.id }).properties).toMatchObject({
        name: "Start",
        classification: "Design/Mechanical",
        state: "Design draft",
    });
});

test("resetting the map recalculates owned relationship behavior and inherited state permissions", async () => {
    await using project = await classificationProject("", { permission: "SEC_READ" });
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });
    const original = await h.getOne("ClassificationRecord", { name: "Start" });
    const link = h.state.getOne("ClassificationLink", { name: "Owned" });
    const changed = await h.update(original, { classification: "Operations" });

    expect(changed.properties.permission_id).toBe("SEC_READ");
    expect(h.state.getOne("ClassificationLink", { id: link.id }).properties).toMatchObject({
        permission_id: "SEC_READ",
        behavior: "float",
        modified_on: link.properties.modified_on,
    });
});

test("the new state's Permission takes precedence over a supplied Permission", async () => {
    await using project = await classificationProject("", { permission: "SEC_READ" });
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });
    const original = await h.getOne("ClassificationRecord", { name: "Start" });
    const changed = await h.update(original, {
        classification: "Operations",
        permission_id: "SEC_HIDDEN",
    });

    expect(changed.properties.permission_id).toBe("SEC_READ");
    expect(
        h.state.getOne("ClassificationRecord", { id: changed.id }).properties.permission_id,
    ).toBe("SEC_READ");
});

test("nested actions see the newly selected Permission before the lifecycle reset finishes", async () => {
    await using project = await classificationProject("", { permission: "SEC_READ" });
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });
    const original = await h.getOne("ClassificationRecord", { name: "Start" });
    const related = h.state.getOne("ClassificationRecord", { name: "Unmapped" });
    const before = h.state.get("ClassificationRecord");
    const links = h.state.get("ClassificationLink");
    const result = await h.applyAML(
        `<Item type="ClassificationRecord" action="edit" id="${original.id}">
            <classification>Operations</classification><Relationships>
                <Item type="ClassificationLink" action="add"><name>Must roll back</name><related_id>${related.id}</related_id></Item>
            </Relationships>
        </Item>`,
    );

    expect(result.getErrorCode()).toBe("PermissionDenied");
    expect(h.state.get("ClassificationRecord")).toEqual(before);
    expect(h.state.get("ClassificationLink")).toEqual(links);
});

test("a locked map change preserves its version cycle and configuration identity", async () => {
    await using project = await classificationProject("", { versionable: true });
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });
    const original = await h.getOne("ClassificationRecord", { name: "Start" });
    await h.applyAML(
        `<Item type="ClassificationRecord" action="lock" id="${original.id}" doGetItem="0" />`,
    );
    const first = await h.applyAML(
        `<Item type="ClassificationRecord" action="update" id="${original.id}"><classification>Operations</classification></Item>`,
    );
    const second = await h.applyAML(
        `<Item type="ClassificationRecord" action="update" id="${first.getID()}"><name>Next save</name></Item>`,
    );

    expect(first.node.properties.new_version).toBe(1);
    expect(second.getID()).toBe(first.getID());
    expect(second.node.properties).toMatchObject({
        config_id: original.id,
        generation: 2,
        name: "Next save",
    });
});

test("a rejecting source hook rolls back the new map, permissions, clones and generation", async () => {
    const source =
        referenceMethod(
            "RejectClassUpdate",
            `
        if (this.getProperty("state") != "Operations draft") {
            throw new Exception("The after hook must observe the new lifecycle");
        }
        return this.getInnovator().newError("Reject reclassification");
    `,
        ) + referenceEvent("CLASS_RECORD", "onAfterUpdate", "RejectClassUpdate");
    await using project = await classificationProject(source, {
        versionable: true,
        permission: "SEC_READ",
    });
    using h = await createHarness({
        cwd: project.cwd,
        authorization: AuthorizationMode.Native,
        csharp: {},
    });
    const original = h.state.getOne("ClassificationRecord", { name: "Start" });
    const records = h.state.get("ClassificationRecord");
    const links = h.state.get("ClassificationLink");
    const result = await h.applyAML(
        `<Item type="ClassificationRecord" action="edit" id="${original.id}"><classification>Operations</classification></Item>`,
    );

    expect(result.getErrorString()).toBe("Reject reclassification");
    expect(h.state.get("ClassificationRecord")).toEqual(records);
    expect(h.state.get("ClassificationLink")).toEqual(links);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
    expect(h.executions.at(-1)?.mocks).toEqual([]);
}, 60_000);

test.each(["onBeforeVersion", "onBeforeUpdate"])(
    "%s can remove a pending class before it reaches storage",
    async (event) => {
        const source =
            referenceMethod(
                "StripPendingClass",
                'this.removeProperty("classification"); return this;',
            ) + referenceEvent("CLASS_RECORD", event, "StripPendingClass");
        await using project = await classificationProject(source, { versionable: true });
        using h = await createHarness({
            cwd: project.cwd,
            authorization: AuthorizationMode.Native,
            csharp: {},
        });
        const original = h.state.getOne("ClassificationRecord", { name: "Start" });
        const result = await h.applyAML(
            `<Item type="ClassificationRecord" action="edit" id="${original.id}">
            <classification>Operations</classification><name>Permitted update</name>
        </Item>`,
        );

        expect(result.isError()).toBe(false);
        expect(result.getID()).not.toBe(original.id);
        expect(result.node.properties).toMatchObject({
            name: "Permitted update",
            classification: "Design/Mechanical",
            state: "Design draft",
        });
        expect(
            h.state.getOne("ClassificationRecord", { id: result.getID() }).properties
                .classification,
        ).toBe("Design/Mechanical");
    },
    60_000,
);

test("after-version source reads the clone before the pending business values are saved", async () => {
    const source =
        referenceMethod(
            "ReadVersionClone",
            `
        var query = this.newItem(this.getType(), "get");
        query.setID(eventData.NewItemId);
        var stored = query.apply();
        if (stored.isError()) { return stored; }
        if (stored.getProperty("name") != "Start" ||
            stored.getProperty("classification") != "Design/Mechanical" ||
            stored.getProperty("new_version") != "0") {
            throw new Exception("Pending values were written before the update phase");
        }
        return this;
    `,
        ) + referenceEvent("CLASS_RECORD", "onAfterVersion", "ReadVersionClone");
    await using project = await classificationProject(source, { versionable: true });
    using h = await createHarness({
        cwd: project.cwd,
        authorization: AuthorizationMode.Native,
        csharp: {},
    });
    const original = await h.getOne("ClassificationRecord", { name: "Start" });
    const result = await h.update(original, {
        name: "Saved after the hook",
        classification: "Operations",
    });

    expect(result.properties).toMatchObject({
        name: "Saved after the hook",
        classification: "Operations",
        state: "Operations draft",
    });
    expect(h.executions.at(-1)?.mocks).toEqual([]);
}, 60_000);
