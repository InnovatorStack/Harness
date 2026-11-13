import { expect, test } from "bun:test";

import { createHarness } from "../src/index.js";
import { itemOrigin } from "../src/items/origins.js";
import { observingCSharp } from "./helpers/failed-context.js";
import type { MethodContextObservation } from "./helpers/failed-context.js";
import { generatedUpdateSources } from "./helpers/generated-updates.js";
import { referenceEvent, referenceMethod, referenceProject } from "./helpers/references.js";

test.each(["action", "query"])(
    "nested relationship %s retains its pending origin through scoped execution",
    async (operation) => {
        const parentName = operation === "action" ? "ReplaceUpdate" : "ObserveParent";
        const parentSource =
            operation === "action"
                ? generatedUpdateSources(
                      true,
                      "// MethodTemplateName = CSharpInOut;\neventData.BaseUpdateItem(outDom);",
                  )
                : referenceMethod(
                      "ObserveParent",
                      "// MethodTemplateName = CSharpInOut;\neventData.BaseGetItem(outDom);",
                  ) + referenceEvent("REF_RECORD", "onGet", "ObserveParent");
        const childEvent = operation === "action" ? "onBeforeAdd" : "onBeforeGet";
        const source =
            parentSource +
            referenceMethod("ObserveChild", "return this;") +
            referenceEvent("ReferenceFixed", childEvent, "ObserveChild");
        const fixtures =
            operation === "query"
                ? `ReferenceFixed: [{ source_id: { name: "Parent" }, related_id: { name: "Child" }, sort_order: 7 }],`
                : "";
        await using project = await referenceProject(source, fixtures);
        const observations: MethodContextObservation[] = [];
        using h = await createHarness({
            cwd: project.cwd,
            executors: [observingCSharp(observations)],
        });
        const parent = h.state.getOne("ReferenceRecord", { name: "Parent" });
        const child = h.state.getOne("ReferenceRecord", { name: "Child" });
        const action = operation === "action" ? "edit" : "get";
        const nested =
            operation === "action"
                ? `<Item type="ReferenceFixed" action="add"><related_id>${child.id}</related_id><sort_order>10</sort_order></Item>`
                : '<Item type="ReferenceFixed" action="get" />';
        const response =
            await h.applyAML(`<Item type="ReferenceRecord" action="${action}" id="${parent.id}">
            <Relationships>${nested}</Relationships></Item>`);
        const enclosing = observations.find((entry) => entry.method === parentName)?.context;
        const observed = observations.find((entry) => entry.method === "ObserveChild")?.context;

        if (!enclosing || !observed) {
            throw new Error("Both original source Methods must observe the nested request.");
        }

        const origin = itemOrigin(enclosing.getRelationships().node);

        expect(response.isError()).toBe(false);
        expect(origin).toBeDefined();
        expect(itemOrigin(observed.node)).toBe(origin);
        expect(h.executions.at(-1)?.mocks).toEqual([]);
    },
    60_000,
);
