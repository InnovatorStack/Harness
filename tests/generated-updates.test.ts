import { expect, test } from "bun:test";

import { createHarness, ExecutionOutcome } from "../src/index.js";
import { parseItems } from "../src/items/xml.js";
import { generatedUpdateSources } from "./helpers/generated-updates.js";
import { referenceEvent, referenceMethod, referenceProject } from "./helpers/references.js";
import { updateEventSources } from "./helpers/update-events.js";

test("real replacement source intercepts both direct-update passes and preserves responses", async () => {
    await using project = await referenceProject(updateEventSources + generatedUpdateSources());
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const parent = h.state.getOne("ReferenceRecord", { name: "Parent" });
    await h.applyAML(`<Item type="ReferenceRecord" action="lock" id="${parent.id}" />`);
    const result = await h.applyAML(
        `<Item type="ReferenceRecord" action="update" id="${parent.id}" select="name"><name>Change generated input</name></Item>`,
    );

    expect(result.getID()).not.toBe(parent.id);
    expect(result.node.properties).toEqual({
        name: "Saved by replacement",
        generated_response: "source",
        initial_response: "source",
    });
    expect(h.state.getOne("ReferenceRecord", { id: result.getID() }).properties).toMatchObject({
        name: "Saved by replacement",
        generation: 2,
        config_id: parent.id,
        locked_by_id: h.state.getOne("User", { login_name: "reference_owner" }).id,
        new_version: 1,
    });
    expect(h.trace.filter((event) => event.kind === "method").map((event) => event.name)).toEqual([
        "ReplaceUpdate",
        "ObserveUpdate",
        "ObserveVersion",
        "ReplaceUpdate",
        "ObserveUpdate",
    ]);
    const input = h.state.getOne("ReplacementAudit", { phase: "generated" });
    const request = parseItems(String(input.properties.request_xml))[0];

    expect(request?.node.attributes).toMatchObject({
        id: result.getID(),
        action: "version",
        oldId: parent.id,
    });
    expect(request?.getProperty("new_version")).toBe("1");
    expect(h.executions.at(-1)?.mocks).toEqual([]);
    expect(h.executions.at(-1)?.truncated).toBe(false);
}, 60_000);

test("explicit version invokes its replacement only after the version hooks finish", async () => {
    await using project = await referenceProject(updateEventSources + generatedUpdateSources());
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const parent = h.state.getOne("ReferenceRecord", { name: "Parent" });
    const result = await h.applyAML(
        `<Item type="ReferenceRecord" action="version" id="${parent.id}"><name>Change generated input</name></Item>`,
    );

    expect(result.isError()).toBe(false);
    expect(result.getProperty("name")).toBe("Saved by replacement");
    expect(result.getProperty("generated_response")).toBe("source");
    expect(result.node.properties).not.toHaveProperty("initial_response");
    expect(h.state.get("ReplacementAudit")).toHaveLength(1);
    expect(h.state.getOne("ReplacementAudit", {}).properties.phase).toBe("generated");
    expect(h.trace.filter((event) => event.kind === "method").map((event) => event.name)).toEqual([
        "ObserveVersion",
        "ReplaceUpdate",
        "ObserveUpdate",
    ]);
}, 60_000);

test("a generated replacement owns the update and may leave the cloned values untouched", async () => {
    await using project = await referenceProject(updateEventSources + generatedUpdateSources());
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const parent = h.state.getOne("ReferenceRecord", { name: "Parent" });
    const result = await h.applyAML(
        `<Item type="ReferenceRecord" action="version" id="${parent.id}"><name>Skip generated update</name></Item>`,
    );
    const current = h.state.getOne("ReferenceRecord", { config_id: parent.id, is_current: 1 });

    expect(result.getResult()).toBe("Replaced generated update");
    expect(current.id).not.toBe(parent.id);
    expect(current.properties).toMatchObject({ name: "Parent", generation: 2, new_version: 0 });
    expect(current.properties.locked_by_id).toBeTruthy();
    expect(h.state.get("UpdateAudit", { phase: "reentry" })).toEqual([]);
    expect(h.executions.at(-1)?.changes.some((change) => change.name === "version")).toBe(true);
    expect(h.executions.at(-1)?.changes.some((change) => change.name === "update")).toBe(false);
}, 60_000);

test("failure after a generated base save rolls back generations, source writes and locks", async () => {
    await using project = await referenceProject(updateEventSources + generatedUpdateSources());
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const parent = h.state.getOne("ReferenceRecord", { name: "Parent" });
    const before = h.state.get("ReferenceRecord");

    await expect(
        h.applyAML(
            `<Item type="ReferenceRecord" action="edit" id="${parent.id}"><name>Reject after base</name></Item>`,
        ),
    ).rejects.toThrow("Rejected after generated base update");
    expect(h.state.get("ReferenceRecord")).toEqual(before);
    expect(h.state.get("ReplacementAudit")).toEqual([]);
    expect(h.state.get("UpdateAudit")).toEqual([]);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
    expect(h.executions.at(-1)?.changes.filter((change) => change.name === "version")).toHaveLength(
        1,
    );
    expect(h.executions.at(-1)?.changes.filter((change) => change.name === "update")).toHaveLength(
        1,
    );
}, 60_000);

test("generated base delegation uses captured targets even if its Method rewrites the selector", async () => {
    await using project = await referenceProject(generatedUpdateSources());
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const parent = h.state.getOne("ReferenceRecord", { name: "Parent" });
    const result = await h.applyAML(
        `<Item type="ReferenceRecord" action="edit" id="${parent.id}"><name>Redirect selector</name></Item>`,
    );

    expect(result.isError()).toBe(false);
    expect(result.getID()).not.toBe(parent.id);
    expect(h.state.getOne("ReferenceRecord", { id: parent.id }).properties.name).toBe("Parent");
    expect(h.state.getOne("ReferenceRecord", { id: result.getID() }).properties).toMatchObject({
        name: "Redirect selector",
        generation: 2,
    });
}, 60_000);

test("initial update replacement cannot redirect its captured batch by rewriting the selector", async () => {
    const code = `// MethodTemplateName = CSharpInOut;
        var input = inDom.DocumentElement ?? throw new Exception("Missing input");
        if (String.IsNullOrEmpty(input.GetAttribute("oldId"))) {
            var innovator = new Innovator(InnovatorServerASP);
            var query = innovator.newItem("ReferenceRecord", "get");
            query.setProperty("name", "Child");
            var child = query.apply();
            if (child.isError()) { throw new Exception(child.getErrorString()); }
            input.SetAttribute("id", child.getID());
        }
        eventData.BaseUpdateItem(outDom);
    `;
    await using project = await referenceProject(generatedUpdateSources(false, code));
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const parent = h.state.getOne("ReferenceRecord", { name: "Parent" });
    const child = h.state.getOne("ReferenceRecord", { name: "Child" });
    const result = await h.applyAML(
        `<Item type="ReferenceRecord" action="edit" id="${parent.id}"><name>Saved parent</name></Item>`,
    );

    expect(result.isError()).toBe(false);
    expect(result.node.properties).toMatchObject({
        name: "Saved parent",
        config_id: parent.id,
        generation: 2,
    });
    expect(h.state.getOne("ReferenceRecord", { id: child.id })).toEqual(child);
    expect(h.state.get("ReferenceRecord", { config_id: child.id })).toHaveLength(1);
}, 60_000);

test.each([false, true])(
    "generated replacement honors optional and required suppression: required=%s",
    async (required) => {
        await using project = await referenceProject(
            updateEventSources + generatedUpdateSources(required),
        );
        using h = await createHarness({ cwd: project.cwd, csharp: {} });
        const parent = h.state.getOne("ReferenceRecord", { name: "Parent" });
        const result = await h.applyAML(
            `<Item type="ReferenceRecord" action="edit" id="${parent.id}" serverEvents="0"><name>Saved</name></Item>`,
        );

        expect(result.isError()).toBe(false);
        expect(
            h.state
                .get("ReplacementAudit")
                .map((record) => record.properties.phase)
                .sort((left, right) => String(left).localeCompare(String(right))),
        ).toEqual(required ? ["generated", "initial"] : []);
        expect(
            h.state
                .get("UpdateAudit")
                .map((record) => record.properties.phase)
                .sort((left, right) => String(left).localeCompare(String(right))),
        ).toEqual(["preflight", "reentry", "version"]);
    },
    60_000,
);

test("the edit wrapper fetches its final result after replacements and unlock", async () => {
    const source =
        generatedUpdateSources() +
        referenceMethod(
            "InspectUnlockedResponse",
            `
            if (this.getProperty("name") == "Saved" &&
                !String.IsNullOrEmpty(this.getProperty("locked_by_id"))) {
                throw new Exception("Get ran before generated edit unlock");
            }
            this.setProperty("response_hook", "after get");
            return this;
        `,
        ) +
        referenceEvent("REF_RECORD", "onAfterGet", "InspectUnlockedResponse");
    await using project = await referenceProject(source);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const parent = h.state.getOne("ReferenceRecord", { name: "Parent" });
    const result = await h.applyAML(
        `<Item type="ReferenceRecord" action="edit" id="${parent.id}"><name>Saved</name></Item>`,
    );

    expect(result.node.properties).toMatchObject({
        name: "Saved",
        locked_by_id: null,
        response_hook: "after get",
    });
    expect(result.node.properties).not.toHaveProperty("generated_response");
    expect(result.node.properties).not.toHaveProperty("initial_response");
    expect(h.state.getOne("ReferenceRecord", { id: result.getID() }).properties).not.toHaveProperty(
        "response_hook",
    );
}, 60_000);
