import { expect, test } from "bun:test";

import { createHarness } from "../src/index.js";
import { ServerEventVersion } from "../src/platform/events/types.js";
import { metadataProject } from "./helpers/event-metadata.js";
import { referenceEvent, referenceMethod } from "./helpers/references.js";

test.each([ServerEventVersion.Item, ServerEventVersion.Collection])(
    "CSharpInOut receives native after-version arguments for %s",
    async (version) => {
        const source =
            referenceMethod(
                "VersionInOut",
                `
            // MethodTemplateName = CSharpInOut;
            var innovator = new Innovator(InnovatorServerASP);
            var input = inDom.DocumentElement ?? throw new Exception("Missing context");
            var audit = innovator.newItem("MetadataAudit", "add");
            audit.setProperty("phase", "InOutVersion");
            audit.setProperty("item_id", input.GetAttribute("id"));
            audit.setProperty("new_id", eventData.NewItemId);
            audit.setProperty("type_id", eventData.TypeId);
            audit.setProperty("mapping", Newtonsoft.Json.JsonConvert.SerializeObject(eventData.OldIdsNewIdsMap));
            var result = audit.apply();
            if (result.isError()) { throw new Exception(result.getErrorString()); }
            outDom.LoadXml("<Result />");
        `,
            ) + referenceEvent("REF_RECORD", "onAfterVersion", "VersionInOut", { version });
        await using project = await metadataProject(source, false);
        using h = await createHarness({ cwd: project.cwd, csharp: {} });
        const parent = h.state.getOne("ReferenceRecord", { name: "Parent" });
        const result = await h.applyAML(
            `<Item type="ReferenceRecord" action="version" id="${parent.id}" />`,
        );
        const audit = h.state.getOne("MetadataAudit", { phase: "InOutVersion" });

        expect(result.isError()).toBe(false);
        expect(audit.properties.item_id).toBe(version === ServerEventVersion.Item ? parent.id : "");
        expect(audit.properties.new_id).toBe(
            version === ServerEventVersion.Item ? result.getID() : "",
        );
        expect(audit.properties.type_id).toBe(
            h.state.getOne("ItemType", { name: "ReferenceRecord" }).id,
        );
        expect(JSON.parse(String(audit.properties.mapping))).toEqual({
            [parent.id]: result.getID(),
        });
    },
    60_000,
);

test.each([ServerEventVersion.Item, ServerEventVersion.Collection])(
    "native after-add metadata identifies persisted records for %s",
    async (version) => {
        const source =
            referenceMethod(
                "AddedMetadata",
                `
            if (eventData.IdList.Single() != eventData.Id) { throw new Exception("Wrong add ID list"); }
            var query = this.newItem("ReferenceRecord", "get");
            query.setID(eventData.Id);
            if (query.apply().getProperty("name") != "Added") { throw new Exception("Add was not persisted"); }
            var audit = this.newItem("MetadataAudit", "add");
            audit.setProperty("phase", "AfterAdd");
            audit.setProperty("item_id", this.getID());
            audit.setProperty("new_id", eventData.Id);
            audit.setProperty("type_id", eventData.TypeId);
            var result = audit.apply();
            if (result.isError()) { return result; }
            return this;
        `,
            ) + referenceEvent("REF_RECORD", "onAfterAdd", "AddedMetadata", { version });
        await using project = await metadataProject(source, false);
        using h = await createHarness({ cwd: project.cwd, csharp: {} });
        const result = await h.applyAML(
            '<Item type="ReferenceRecord" action="add"><name>Added</name></Item>',
        );
        const audit = h.state.getOne("MetadataAudit", { phase: "AfterAdd" });

        expect(result.isError()).toBe(false);
        expect(audit.properties.item_id).toBe(
            version === ServerEventVersion.Item ? result.getID() : "",
        );
        expect(audit.properties.new_id).toBe(result.getID());
        expect(audit.properties.type_id).toBe(
            h.state.getOne("ItemType", { name: "ReferenceRecord" }).id,
        );
    },
    60_000,
);

test.each([ServerEventVersion.Item, ServerEventVersion.Collection])(
    "after-version context loading obeys the native %s profile and rolls back rejected reads",
    async (version) => {
        const source =
            referenceMethod(
                "RejectContextRead",
                `
            return this.getInnovator().newError("Reject context read");
        `,
            ) +
            referenceEvent("REF_RECORD", "onBeforeGet", "RejectContextRead") +
            referenceMethod("MetadataOnlyVersion", "return this;") +
            referenceEvent("REF_RECORD", "onAfterVersion", "MetadataOnlyVersion", { version });
        await using project = await metadataProject(source, false);
        using h = await createHarness({ cwd: project.cwd, csharp: {} });
        const parent = h.state.getOne("ReferenceRecord", { name: "Parent" });
        const baseline = h.state.get("ReferenceRecord");
        const result = await h.applyAML(
            `<Item type="ReferenceRecord" action="version" id="${parent.id}" doGetItem="0" />`,
        );

        if (version === ServerEventVersion.Item) {
            expect(result.getErrorString()).toBe("Reject context read");
            expect(h.state.get("ReferenceRecord")).toEqual(baseline);
            expect(h.state.get("MetadataAudit")).toEqual([]);
        } else {
            expect(result.isError()).toBe(false);
            expect(result.getID()).not.toBe(parent.id);
            expect(h.trace.some((event) => event.name === "RejectContextRead")).toBe(false);
        }
    },
    60_000,
);

test("a rejected explicit-version return Get rolls back after metadata-only version hooks", async () => {
    const source =
        referenceMethod(
            "RejectReturnGet",
            'return this.getInnovator().newError("Return Get rejected");',
        ) +
        referenceEvent("REF_RECORD", "onBeforeGet", "RejectReturnGet") +
        referenceMethod("BeforeReturnGet", "return this;") +
        referenceEvent("REF_RECORD", "onAfterVersion", "BeforeReturnGet", {
            version: ServerEventVersion.Collection,
        });
    await using project = await metadataProject(source, false);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const parent = h.state.getOne("ReferenceRecord", { name: "Parent" });
    const baseline = h.state.get("ReferenceRecord");
    const result = await h.applyAML(
        `<Item type="ReferenceRecord" action="version" id="${parent.id}" />`,
    );

    expect(result.getErrorString()).toBe("Return Get rejected");
    expect(h.state.get("ReferenceRecord")).toEqual(baseline);
    expect(h.state.get("MetadataAudit")).toEqual([]);
    expect(h.trace.filter((event) => event.kind === "method").map((event) => event.name)).toEqual([
        "BeforeReturnGet",
        "MetadataBeforeUpdate",
        "RejectReturnGet",
    ]);
    expect(h.executions.at(-1)?.changes.filter((change) => change.name === "version")).toHaveLength(
        1,
    );
}, 60_000);
