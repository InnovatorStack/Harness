import { expect, test } from "bun:test";

import { createHarness, ExecutionOutcome } from "../src/index.js";
import type { Harness } from "../src/index.js";
import { ServerEventVersion } from "../src/platform/events/types.js";
import { metadataMethod, metadataProject } from "./helpers/event-metadata.js";
import { referenceEvent, referenceMethod } from "./helpers/references.js";

function batchMethod(name: string, event: "onAfterVersion" | "onAfterUpdate"): string {
    const scalar = event === "onAfterVersion" ? "eventData.NewItemId" : 'eventData.Id ?? "null"';
    const source = metadataMethod(
        name,
        `
        if (this.getType() != "" || this.getID() != "" || this.getItemCount() != 1) {
            throw new Exception("A version-2 hook must receive an empty Item");
        }
        audit.setProperty("phase", "${name}");
        audit.setProperty("type_id", eventData.TypeId);
        audit.setProperty("new_id", ${scalar});
        audit.setProperty("ids", string.Join(",", eventData.NewItemsIds));
        audit.setProperty("mapping", Newtonsoft.Json.JsonConvert.SerializeObject(eventData.OldIdsNewIdsMap));
    `,
    );

    return (
        source +
        referenceEvent("REF_RECORD", event, name, {
            version: ServerEventVersion.Collection,
            order: 30,
        })
    );
}

const updateItem =
    metadataMethod(
        "MetadataUpdateItem",
        `
    if (eventData.Id != this.getID()) { throw new Exception("Wrong after-update ID"); }
    audit.setProperty("phase", "UpdateItem");
    audit.setProperty("type_id", eventData.TypeId);
    audit.setProperty("new_id", eventData.Id);
    audit.setProperty("mapping", Newtonsoft.Json.JsonConvert.SerializeObject(eventData.OldIdsNewIdsMap));
`,
    ) + referenceEvent("REF_RECORD", "onAfterUpdate", "MetadataUpdateItem", { order: 10 });

function expectAuditMappings(h: Harness, mapping: unknown, typeId: string): void {
    for (const phase of ["VersionItem", "VersionBatch", "UpdateItem", "UpdateBatch"]) {
        const audits = h.state.get("MetadataAudit", { phase });
        expect(audits).toHaveLength(phase.endsWith("Item") ? 2 : 1);

        for (const audit of audits) {
            expect(JSON.parse(String(audit.properties.mapping))).toEqual(mapping);
            expect(audit.properties.type_id).toBe(typeId);
        }
    }
}

test("real C# receives old version contexts, complete mappings and both before-update ID lists", async () => {
    const extra =
        updateItem +
        batchMethod("VersionBatch", "onAfterVersion") +
        batchMethod("UpdateBatch", "onAfterUpdate");
    await using project = await metadataProject(extra);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const parent = h.state.getOne("ReferenceRecord", { name: "Parent" });
    const child = h.state.getOne("ReferenceRecord", { name: "Child" });
    const result = await h.applyAML(`<Item type="ReferenceRecord" action="edit"
        idlist="${parent.id},${child.id}"><name>Changed</name></Item>`);
    const ids: readonly [string, string] = [
        result.getItemByIndex(0).getID(),
        result.getItemByIndex(1).getID(),
    ];
    const mapping = { [parent.id]: ids[0], [child.id]: ids[1] };
    const versions = h.state.get("MetadataAudit", { phase: "VersionItem" });
    const typeId = h.state.getOne("ItemType", { name: "ReferenceRecord" }).id;

    expect(result.isError()).toBe(false);
    expect(result.getItemCount()).toBe(2);
    expect(versions.map((row) => row.properties.context_generation)).toEqual(["1", "1"]);
    expect(new Set(versions.map((row) => row.properties.context_name))).toEqual(
        new Set(["Parent", "Child"]),
    );
    expect(
        h.state.getOne("MetadataAudit", {
            phase: "BeforeUpdate",
            item_id: parent.id,
        }).properties.ids,
    ).toBe(`${parent.id},${child.id}`);

    for (const [id, newId] of Object.entries(mapping)) {
        expect(
            h.state.getOne("MetadataAudit", {
                phase: "VersionItem",
                item_id: id,
            }).properties.new_id,
        ).toBe(newId);
        expect(
            h.state.getOne("MetadataAudit", {
                phase: "BeforeUpdate",
                item_id: newId,
            }).properties.ids,
        ).toBe(ids.join(","));
    }

    expectAuditMappings(h, mapping, typeId);

    expect(h.state.getOne("MetadataAudit", { phase: "VersionBatch" }).properties.new_id).toBe(
        ids[0],
    );
    expect(h.state.getOne("MetadataAudit", { phase: "UpdateBatch" }).properties.new_id).toBe(
        ids[0],
    );
    expect(
        h.state
            .get("MetadataAudit", { phase: "UpdateItem" })
            .every(
                (row) =>
                    row.properties.context_generation === "2" &&
                    row.properties.context_name === "Changed",
            ),
    ).toBe(true);
    expect(h.executions.at(-1)?.mocks).toEqual([]);
}, 60_000);

test("metadata-only batch hooks retain native empty scalar IDs and execute once", async () => {
    await using project = await metadataProject(
        batchMethod("VersionBatch", "onAfterVersion") + batchMethod("UpdateBatch", "onAfterUpdate"),
        false,
    );
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const parent = h.state.getOne("ReferenceRecord", { name: "Parent" });
    const result = await h.applyAML(
        `<Item type="ReferenceRecord" action="edit" id="${parent.id}" />`,
    );

    expect(result.isError()).toBe(false);
    expect(h.state.getOne("MetadataAudit", { phase: "VersionBatch" }).properties).toMatchObject({
        item_id: "",
        context_name: "",
        context_generation: "",
        new_id: "",
    });
    expect(h.state.getOne("MetadataAudit", { phase: "UpdateBatch" }).properties.new_id).toBe(
        "null",
    );
});

test("a rejecting after-version Method rolls back writes addressed through its generation mapping", async () => {
    const source =
        referenceMethod(
            "RejectMappedVersion",
            `
        var update = this.newItem(this.getType(), "update");
        update.setID(eventData.NewItemId);
        update.setAttribute("version", "0");
        update.setAttribute("serverEvents", "0");
        update.setProperty("name", "Must roll back");
        var result = update.apply();
        if (result.isError()) { return result; }
        return this.getInnovator().newError("Reject mapped version");
    `,
        ) + referenceEvent("REF_RECORD", "onAfterVersion", "RejectMappedVersion", { order: 20 });
    await using project = await metadataProject(source);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const parent = h.state.getOne("ReferenceRecord", { name: "Parent" });
    const baseline = h.state.get("ReferenceRecord");
    const result = await h.applyAML(
        `<Item type="ReferenceRecord" action="edit" id="${parent.id}" />`,
    );

    expect(result.getErrorString()).toBe("Reject mapped version");
    expect(h.state.get("ReferenceRecord")).toEqual(baseline);
    expect(h.state.get("MetadataAudit")).toEqual([]);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
});

test("version-2 before-update hooks receive metadata without modifying pending Item properties", async () => {
    const source =
        metadataMethod(
            "BeforeUpdateBatch",
            `
        if (this.getType() != "" || !eventData.IdList.Contains(eventData.Id)) {
            throw new Exception("Wrong before-update metadata");
        }
        audit.setProperty("phase", "BeforeBatch");
        audit.setProperty("new_id", eventData.Id);
        audit.setProperty("ids", string.Join(",", eventData.IdList));
        this.setProperty("name", "Must not replace pending values");
    `,
        ) +
        referenceEvent("REF_RECORD", "onBeforeUpdate", "BeforeUpdateBatch", {
            version: ServerEventVersion.Collection,
            order: 5,
        });
    await using project = await metadataProject(source, false);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const parent = h.state.getOne("ReferenceRecord", { name: "Parent" });
    const result = await h.applyAML(`<Item type="ReferenceRecord" action="edit" id="${parent.id}">
        <name>Changed</name></Item>`);

    expect(result.getProperty("name")).toBe("Changed");
    expect(h.state.get("MetadataAudit", { phase: "BeforeBatch" })).toHaveLength(2);
    expect(
        h.state.getOne("MetadataAudit", {
            phase: "BeforeBatch",
            new_id: result.getID(),
        }).properties.ids,
    ).toBe(result.getID());
});

test("required batch hooks retain scalar IDs when optional item hooks are suppressed", async () => {
    const source =
        referenceMethod("OptionalItemUpdate", 'throw new Exception("Optional item hook ran");') +
        referenceEvent("REF_RECORD", "onAfterUpdate", "OptionalItemUpdate", { order: 10 }) +
        metadataMethod(
            "RequiredUpdateBatch",
            `
            var id = eventData.Id ?? throw new Exception("Missing prepared item identity");
            if (eventData.NewItemsIds.Single() != id) { throw new Exception("Wrong update identity"); }
            audit.setProperty("phase", "RequiredBatch");
            audit.setProperty("new_id", id);
        `,
        ) +
        referenceEvent("REF_RECORD", "onAfterUpdate", "RequiredUpdateBatch", {
            version: ServerEventVersion.Collection,
            required: true,
            order: 20,
        }) +
        referenceMethod("SuppressedContextGet", 'throw new Exception("Optional Get hook ran");') +
        referenceEvent("REF_RECORD", "onBeforeGet", "SuppressedContextGet");
    await using project = await metadataProject(source, false);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const parent = h.state.getOne("ReferenceRecord", { name: "Parent" });
    const result = await h.applyAML(`<Item type="ReferenceRecord" action="edit"
        id="${parent.id}" serverEvents="0"><name>Saved</name></Item>`);

    expect(result.isError()).toBe(false);
    expect(h.state.getOne("MetadataAudit", { phase: "RequiredBatch" }).properties.new_id).toBe(
        result.getID(),
    );
    expect(h.trace.some((event) => event.name === "OptionalItemUpdate")).toBe(false);
    expect(h.trace.some((event) => event.name === "SuppressedContextGet")).toBe(false);
});
