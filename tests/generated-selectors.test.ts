import { expect, test } from "bun:test";

import { createHarness } from "../src/index.js";
import { parseItems } from "../src/items/xml.js";
import { generatedUpdateSources } from "./helpers/generated-updates.js";
import { referenceProject } from "./helpers/references.js";

const selectors = ["id", "single idlist", "bulk idlist", "single where", "bulk where"];
const profiles = ["edit", "version"].flatMap((action) =>
    selectors.map((selector) => ({ action, selector })),
);

test.each(profiles)(
    "generated criteria follow native action and selector normalization: %j",
    async ({ action, selector }) => {
        await using project = await referenceProject(generatedUpdateSources());
        using h = await createHarness({ cwd: project.cwd, csharp: {} });
        const parent = h.state.getOne("ReferenceRecord", { name: "Parent" });
        const child = h.state.getOne("ReferenceRecord", { name: "Child" });
        const bulk = selector.startsWith("bulk");
        const where = selector.endsWith("where");
        const ids = bulk ? [child.id, parent.id] : [parent.id];
        const expression = bulk ? "name IN ('Parent', 'Child')" : "name = 'Parent'";
        let criteria = `id="${parent.id}"`;

        if (where) {
            criteria = `where="${expression}" orderBy="name"`;
        } else if (selector.endsWith("idlist")) {
            criteria = `idlist="${ids.join(", ")}"`;
        }

        const result = await h.applyAML(
            `<Item type="ReferenceRecord" action="${action}" ${criteria}><name>Saved</name></Item>`,
        );
        const audit = h.state.getOne("ReplacementAudit", { phase: "generated" });
        const request = parseItems(String(audit.properties.request_xml))[0];
        const generatedIds = result.payload.items.map((item) => item.attributes.id);
        const scalar = !bulk && !(action === "version" && where);

        expect(result.isError()).toBe(false);
        expect(result.payload.items.map((item) => item.properties.config_id)).toEqual(ids);
        expect(result.payload.items.every((item) => item.properties.generation === 2)).toBe(true);
        expect(request?.getAttribute("oldId")).toBe(
            action === "version" && where
                ? ` ( ${expression} ) /*WhereClauseHelper marker*/ `
                : ids.join(","),
        );
        expect(request?.getAttribute("where")).toBe("");
        expect(request?.getID()).toBe(scalar ? generatedIds[0] : "");
        expect(request?.getAttribute("idlist")).toBe(scalar ? "" : generatedIds.join(","));
        expect(h.state.get("ReplacementAudit")).toHaveLength(action === "version" ? 1 : 2);
        expect(
            h.executions.at(-1)?.changes.filter((change) => change.name === "version"),
        ).toHaveLength(ids.length);
    },
    60_000,
);

test.each(["edit", "version"])(
    "generated base respects minimal responses without fetching them again: %s",
    async (action) => {
        await using project = await referenceProject(generatedUpdateSources());
        using h = await createHarness({ cwd: project.cwd, csharp: {} });
        const parent = h.state.getOne("ReferenceRecord", { name: "Parent" });
        const result = await h.applyAML(
            `<Item type="ReferenceRecord" action="${action}" id="${parent.id}" doGetItem="0"><name>Saved</name></Item>`,
        );

        expect(result.isError()).toBe(false);
        expect(result.node.properties).toEqual(
            action === "version" ? { generated_response: "source" } : {},
        );
        expect(h.state.getOne("ReferenceRecord", { id: result.getID() }).properties).toMatchObject({
            name: "Saved",
            generation: 2,
            config_id: parent.id,
        });
    },
    60_000,
);

test("manual explicit version delegates without adding the automatic new_version input", async () => {
    const manual = `<Item type="ItemType" action="edit" id="REF_RECORD">
        <manual_versioning>1</manual_versioning></Item>`;
    await using project = await referenceProject(generatedUpdateSources() + manual);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const parent = h.state.getOne("ReferenceRecord", { name: "Parent" });
    const result = await h.applyAML(
        `<Item type="ReferenceRecord" action="version" id="${parent.id}"><name>Saved</name></Item>`,
    );
    const audit = h.state.getOne("ReplacementAudit", { phase: "generated" });
    const request = parseItems(String(audit.properties.request_xml))[0];

    expect(result.isError()).toBe(false);
    expect(request?.node.properties).not.toHaveProperty("new_version");
    expect(h.state.getOne("ReferenceRecord", { id: result.getID() }).properties).toMatchObject({
        name: "Saved",
        generation: 2,
        new_version: 1,
        config_id: parent.id,
    });
}, 60_000);
