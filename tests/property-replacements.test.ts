import { expect, test } from "bun:test";

import { createHarness, ExecutionOutcome, seededIds } from "../src/index.js";
import { observingCSharp } from "./helpers/failed-context.js";
import type { MethodContextObservation } from "./helpers/failed-context.js";
import { generatedUpdateSources } from "./helpers/generated-updates.js";
import { propertyReplacement, replacePropertyInput } from "./helpers/property-replacements.js";
import { referenceEvent, referenceMethod, referenceProject } from "./helpers/references.js";

const templates = ["CSharp", "CSharpInOut"] as const;
const profiles = templates.flatMap((template) =>
    ["Child", "Other parent"].map((target) => ({ template, target })),
);

test.each(templates)(
    "replaced property views remain observable after rejection with reset and world isolation: %s",
    async (template) => {
        const source =
            generatedUpdateSources(true, propertyReplacement(template)) +
            referenceMethod("ReplacePropertyInput", replacePropertyInput) +
            referenceEvent("REF_RECORD", "onBeforeVersion", "ReplacePropertyInput") +
            referenceMethod(
                "RejectPropertyVersion",
                'return this.getInnovator().newError("Reject property version");',
            ) +
            referenceEvent("REF_RECORD", "onAfterVersion", "RejectPropertyVersion");
        await using project = await referenceProject(source);
        const observed: MethodContextObservation[] = [];
        using h = await createHarness({
            cwd: project.cwd,
            ids: seededIds("property-replacement-reset"),
            executors: [observingCSharp(observed)],
        });
        using other = await createHarness({ cwd: project.cwd });
        const before = h.state.get("ReferenceRecord");
        const otherBefore = other.state.get("ReferenceRecord");
        const parent = h.state.getOne("ReferenceRecord", { name: "Parent" });

        for (let attempt = 0; attempt < 2; attempt++) {
            h.reset();
            observed.length = 0;
            const result =
                await h.applyAML(`<Item type="ReferenceRecord" action="edit" id="${parent.id}">
                <name>Other parent</name><fixed_ref keyed_name="Keep">
                    <Item type="ReferenceRecord" action="get"><name>Child</name></Item>
                </fixed_ref></Item>`);

            expect(result.getErrorString()).toBe("Reject property version");
            expect(
                observed.some(
                    ({ context }) => context.getAttribute("replacement_verified") === "1",
                ),
            ).toBe(true);
            expect(h.state.get("ReferenceRecord")).toEqual(before);
            expect(other.state.get("ReferenceRecord")).toEqual(otherBefore);
            expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
        }
    },
    60_000,
);

test.each(profiles)(
    "base delegation replaces an existing property Item with native detached views: %j",
    async ({ template, target }) => {
        const source =
            generatedUpdateSources(true, propertyReplacement(template)) +
            referenceMethod("ReplacePropertyInput", replacePropertyInput) +
            referenceEvent("REF_RECORD", "onBeforeVersion", "ReplacePropertyInput");
        await using project = await referenceProject(source);
        const observed: MethodContextObservation[] = [];
        using h = await createHarness({
            cwd: project.cwd,
            executors: [observingCSharp(observed)],
        });
        const parent = h.state.getOne("ReferenceRecord", { name: "Parent" });
        const expected = h.state.getOne("ReferenceRecord", { name: target });
        const result =
            await h.applyAML(`<Item type="ReferenceRecord" action="edit" id="${parent.id}">
            <name>${target}</name>
            <fixed_ref keyed_name="Keep"><Item type="ReferenceRecord" action="get">
                <name>Child</name></Item></fixed_ref></Item>`);

        expect(result.isError()).toBe(false);
        expect(h.state.getOne("ReferenceRecord", { id: result.getID() }).properties).toMatchObject({
            name: target,
            fixed_ref: expected.id,
            generation: 2,
            config_id: parent.id,
        });
        expect(h.state.getOne("ReferenceRecord", { id: parent.id }).properties.name).toBe("Parent");
        expect(
            observed.some(({ context }) => context.getAttribute("replacement_verified") === "1"),
        ).toBe(true);
        expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.Committed);
        expect(h.executions.at(-1)?.mocks).toEqual([]);
    },
    60_000,
);
