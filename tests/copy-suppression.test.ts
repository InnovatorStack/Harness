import { expect, test } from "bun:test";

import { CapabilityId, createHarness, ExecutionOutcome, seededIds } from "../src/index.js";
import { ServerEventVersion } from "../src/platform/events/types.js";
import { referenceEvent, referenceMethod, referenceProject } from "./helpers/references.js";

const fixtures = `ReferenceFixed: [{ source_id: { name: "Parent" },
    related_id: { name: "Child" }, sort_order: 7 }],`;
const mutationEvents = ["onBeforeAdd", "onAfterAdd", "onBeforeUpdate", "onAfterUpdate"];
const profiles = Object.values(ServerEventVersion).flatMap((version) =>
    [false, true].flatMap((required) =>
        ["0", "1"].flatMap((enabled) =>
            ["edit", "update", "version"].map((action) => ({ version, required, enabled, action })),
        ),
    ),
);

function copyHooks(version: ServerEventVersion, required = true, owner = "ReferenceFixed"): string {
    return (
        referenceMethod("CopyMustNotRun", 'throw new Exception("Business copy hook ran");') +
        ["onBeforeCopy", "onAfterCopy"]
            .map((event) => referenceEvent(owner, event, "CopyMustNotRun", { version, required }))
            .join("")
    );
}

test.each(profiles)(
    "parent version copies bypass business hooks independently of flags and event versions: %j",
    async ({ version, required, enabled, action }) => {
        const mutationHooks =
            referenceMethod("MutationMustNotRun", "invalid C# source") +
            mutationEvents
                .map((event) =>
                    referenceEvent("ReferenceFixed", event, "MutationMustNotRun", {
                        required: true,
                    }),
                )
                .join("");
        await using project = await referenceProject(
            copyHooks(version, required) + mutationHooks,
            fixtures,
        );
        using h = await createHarness({ cwd: project.cwd });
        const parent = h.state.getOne("ReferenceRecord", { name: "Parent" });

        if (action === "update") {
            await h.applyAML(`<Item type="ReferenceRecord" action="lock" id="${parent.id}" />`);
        }

        const result = await h.applyAML(
            `<Item type="ReferenceRecord" action="${action}" id="${parent.id}" serverEvents="${enabled}"><name>Saved</name></Item>`,
        );
        const copied = h.state.getOne("ReferenceFixed", { source_id: result.getID() });

        expect(result.isError()).toBe(false);
        expect(copied.properties).toMatchObject({
            sort_order: 7,
            config_id: copied.id,
            generation: 1,
        });
        expect(h.trace.filter((entry) => entry.kind === "method")).toEqual([]);
        expect(h.executions.at(-1)?.mocks).toEqual([]);
        expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.Committed);
        expect(
            h.executions.at(-1)?.changes.filter((change) => change.name === "copy"),
        ).toHaveLength(1);
    },
);

test("copy mocks remain configured but are never consulted by parent versioning", async () => {
    await using project = await referenceProject(
        copyHooks(ServerEventVersion.Collection),
        fixtures,
    );
    using h = await createHarness({
        cwd: project.cwd,
        mocks: [{ method: "CopyMustNotRun", response: { text: "Configured response" } }],
    });
    const parent = await h.getOne("ReferenceRecord", { name: "Parent" });
    await h.update(parent, { name: "Saved" });

    expect(h.executions.at(-1)?.mocks).toEqual([]);
    expect(h.state.getOne("Method", { name: "CopyMustNotRun" }).properties.method_code).toBe(
        'throw new Exception("Business copy hook ran");',
    );
    const response = await h.callMethod("CopyMustNotRun");
    expect(response.getResult()).toBe("Configured response");
    expect(h.executions.at(-1)?.mocks).toHaveLength(1);
});

test("inherited required copy bindings are skipped while their declarations remain imported", async () => {
    const schema = `<Item type="ItemType" action="add" id="COPY_BASE">
        <name>CopyBase</name><implementation_type>polymorphic</implementation_type></Item>
        <Item type="Morphae" action="add"><source_id>COPY_BASE</source_id>
            <related_id>ReferenceFixed</related_id></Item>`;
    await using project = await referenceProject(
        schema + copyHooks(ServerEventVersion.Collection, true, "COPY_BASE"),
        fixtures,
    );
    using h = await createHarness({ cwd: project.cwd });
    const parent = await h.getOne("ReferenceRecord", { name: "Parent" });
    const saved = await h.update(parent, { name: "Saved" });

    expect(h.state.get("ReferenceFixed", { source_id: saved.id })).toHaveLength(1);
    expect(h.state.get("Server Event", { source_id: "COPY_BASE" })).toHaveLength(2);
    expect(h.trace.filter((entry) => entry.kind === "method")).toEqual([]);
});

test("standalone copy actions retain their explicit unsupported diagnostic", async () => {
    await using project = await referenceProject(
        copyHooks(ServerEventVersion.Collection),
        fixtures,
    );
    using h = await createHarness({ cwd: project.cwd });
    const link = h.state.getOne("ReferenceFixed", {});
    const before = h.state.get("ReferenceFixed");

    await expect(
        h.applyAML(`<Item type="ReferenceFixed" action="copy" id="${link.id}" />`),
    ).rejects.toMatchObject({ code: "UnsupportedAction", capability: CapabilityId.ItemActions });
    expect(h.state.get("ReferenceFixed")).toEqual(before);
    expect(h.trace.filter((entry) => entry.kind === "method")).toEqual([]);
});

test("reset restores copied graphs, history and controlled IDs without changing another world", async () => {
    await using project = await referenceProject(
        copyHooks(ServerEventVersion.Collection),
        fixtures,
    );
    using h = await createHarness({ cwd: project.cwd, ids: seededIds("copy-reset") });
    using other = await createHarness({ cwd: project.cwd, ids: seededIds("copy-reset") });
    const before = h.state.get("ReferenceRecord");
    const links = h.state.get("ReferenceFixed");
    const parent = await h.getOne("ReferenceRecord", { name: "Parent" });
    const saved = await h.update(parent, { name: "Saved" });
    const copied = h.state.getOne("ReferenceFixed", { source_id: saved.id });

    expect(other.state.get("ReferenceRecord")).toEqual(before);
    expect(other.state.get("ReferenceFixed")).toEqual(links);
    h.reset();
    expect(h.state.get("ReferenceRecord")).toEqual(before);
    expect(h.state.get("ReferenceFixed")).toEqual(links);
    expect(h.executions).toEqual([]);
    const repeated = await h.update(await h.getOne("ReferenceRecord", { name: "Parent" }), {
        name: "Saved again",
    });

    expect(repeated.id).toBe(saved.id);
    expect(h.state.getOne("ReferenceFixed", { source_id: repeated.id }).id).toBe(copied.id);
    expect(other.state.get("ReferenceRecord")).toEqual(before);
    expect(other.state.get("ReferenceFixed")).toEqual(links);
});
