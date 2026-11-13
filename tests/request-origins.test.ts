import { expect, test } from "bun:test";

import { createHarness, ExecutionOutcome } from "../src/index.js";
import { generatedUpdateSources } from "./helpers/generated-updates.js";
import { referenceEvent, referenceMethod, referenceProject } from "./helpers/references.js";
import { originReplacement, reorderChangedRequests } from "./helpers/request-origins.js";

const templates = ["CSharp", "CSharpInOut"] as const;
const profiles = templates.flatMap((template) =>
    [false, true].map((repeated) => ({ template, repeated })),
);

test.each(profiles)(
    "changed relationship requests retain their original XML and Item views: %j",
    async ({ template, repeated }) => {
        const hooks =
            referenceMethod("ChangeRequestOrder", reorderChangedRequests) +
            referenceEvent("REF_RECORD", "onBeforeVersion", "ChangeRequestOrder");
        const fixtures = repeated
            ? `ReferenceFixed: [{ source_id: { name: "Parent" }, related_id: { name: "Child" }, sort_order: 7 }],`
            : "";
        await using project = await referenceProject(
            generatedUpdateSources(true, originReplacement(template)) + hooks,
            fixtures,
        );
        using h = await createHarness({ cwd: project.cwd, csharp: {} });
        const parent = h.state.getOne("ReferenceRecord", { name: "Parent" });
        const child = h.state.getOne("ReferenceRecord", { name: "Child" });
        const original = h.state.get("ReferenceFixed", { source_id: parent.id });
        const stored = original[0];
        const attributes = repeated && stored ? `action="edit" id="${stored.id}"` : 'action="add"';
        const result =
            await h.applyAML(`<Item type="ReferenceRecord" action="edit" id="${parent.id}">
            <name>Saved</name><Relationships>
                <Item type="ReferenceFixed" ${attributes}><related_id>${child.id}</related_id><sort_order>10</sort_order></Item>
                <Item type="ReferenceFixed" ${attributes}><related_id>${child.id}</related_id><sort_order>20</sort_order></Item>
            </Relationships></Item>`);
        const current = h.state.get("ReferenceFixed", { source_id: result.getID() });

        expect(result.isError()).toBe(false);
        expect(result.getID()).not.toBe(parent.id);
        expect(
            current.map((row) => row.properties.sort_order).sort((a, b) => Number(a) - Number(b)),
        ).toEqual(repeated ? [99] : [20, 99]);
        const historical = original.map((row) => ({
            ...row,
            properties: { ...row.properties, behavior: "hard_fixed" },
        }));
        expect(h.state.get("ReferenceFixed", { source_id: parent.id })).toEqual(historical);
        expect(h.state.getOne("ReferenceRecord", { id: parent.id }).properties.name).toBe("Parent");
        expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.Committed);
        expect(h.executions.at(-1)?.mocks).toEqual([]);
    },
    60_000,
);
