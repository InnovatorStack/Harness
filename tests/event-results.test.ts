import { expect, test } from "bun:test";

import { createHarness, ExecutionOutcome } from "../src/index.js";
import {
    eventResultSource,
    inOutEventResultSource,
    validateEventInput,
} from "./helpers/event-results.js";
import type { EventResponse } from "./helpers/event-results.js";
import { observingCSharp } from "./helpers/failed-context.js";
import type { MethodContextObservation } from "./helpers/failed-context.js";
import { referenceEvent, referenceMethod, referenceProject } from "./helpers/references.js";

const responses: readonly EventResponse[] = ["item", "result", "empty"];
const templates = ["CSharp", "CSharpInOut"] as const;
const profiles = templates.flatMap((template) =>
    responses.map((response) => ({ template, response })),
);

test.each(profiles)(
    "before-version source mutations survive a separate successful response: %j",
    async ({ template, response }) => {
        const code =
            template === "CSharp" ? eventResultSource(response) : inOutEventResultSource(response);
        const source =
            referenceMethod("MutateVersionInput", code) +
            referenceEvent("REF_RECORD", "onBeforeVersion", "MutateVersionInput", { order: 10 }) +
            referenceMethod("ValidateVersionInput", validateEventInput) +
            referenceEvent("REF_RECORD", "onBeforeVersion", "ValidateVersionInput", { order: 20 });
        await using project = await referenceProject(source);
        using h = await createHarness({ cwd: project.cwd, csharp: {} });
        const parent = await h.getOne("ReferenceRecord", { name: "Parent" });
        const result = await h.update(parent, { name: "Requested" });

        expect(result.properties.name).toBe("Validated input");
        expect(result.properties.config_id).toBe(parent.id);
        expect(result.properties.generation).toBe(2);
        expect(h.state.getOne("ReferenceRecord", { id: parent.id }).properties.name).toBe("Parent");
        expect(
            h.state.getOne("Method", { name: "MutateVersionInput" }).properties.method_code,
        ).toBe(code);
        expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.Committed);
        expect(h.executions.at(-1)?.mocks).toEqual([]);
    },
    60_000,
);

test.each(responses)(
    "before-Get uses mutated criteria and ignores the separate %s response",
    async (response) => {
        const code = eventResultSource(response, "Child");
        await using project = await referenceProject(
            referenceMethod("ChangeCriteria", code) +
                referenceEvent("REF_RECORD", "onBeforeGet", "ChangeCriteria"),
        );
        using h = await createHarness({ cwd: project.cwd, csharp: {} });
        const child = h.state.getOne("ReferenceRecord", { name: "Child" });
        const before = h.state.get("ReferenceRecord");
        const result = await h.applyAML(
            '<Item type="ReferenceRecord" action="get"><name>Parent</name></Item>',
        );

        expect(result.getID()).toBe(child.id);
        expect(result.getProperty("name")).toBe("Child");
        expect(h.state.get("ReferenceRecord")).toEqual(before);
    },
    60_000,
);

test.each(responses)(
    "ordinary Method calls retain their separate %s response",
    async (response) => {
        const code = eventResultSource(response);
        await using project = await referenceProject(referenceMethod("ReturnSeparateData", code));
        const observations: MethodContextObservation[] = [];
        using h = await createHarness({
            cwd: project.cwd,
            executors: [observingCSharp(observations)],
        });
        const result = await h.callMethod("ReturnSeparateData", { name: "Original input" });

        expect(observations[0]?.context.getProperty("name")).toBe("From input");
        expect(result.isError()).toBe(false);

        if (response === "item") {
            expect(result.getProperty("name")).toBe("Response only");
        } else {
            expect(result.getItemCount()).toBe(0);
            expect(result.getResult()).toBe(response === "empty" ? "" : "Response only");
        }
    },
    60_000,
);

test("a later rejecting hook retains earlier input mutations while writes roll back across reset", async () => {
    const reject = `
if (this.getProperty("name") != "From input")
{
    throw new Exception("Earlier input mutation was lost");
}
this.setProperty("name", "Rejected input");
return this.getInnovator().newError("Later hook rejected");`;
    await using project = await referenceProject(
        referenceMethod("MutateBeforeRejection", eventResultSource("result")) +
            referenceEvent("REF_RECORD", "onBeforeVersion", "MutateBeforeRejection", {
                order: 10,
            }) +
            referenceMethod("RejectLaterInput", reject) +
            referenceEvent("REF_RECORD", "onBeforeVersion", "RejectLaterInput", { order: 20 }),
    );
    const observations: MethodContextObservation[] = [];
    using h = await createHarness({
        cwd: project.cwd,
        executors: [observingCSharp(observations)],
    });
    const before = h.state.get("ReferenceRecord");
    const parent = h.state.getOne("ReferenceRecord", { name: "Parent" });

    for (let attempt = 0; attempt < 2; attempt++) {
        h.reset();
        observations.length = 0;
        const result = await h.applyAML(`<Item type="ReferenceRecord" action="edit"
            id="${parent.id}"><name>Requested</name></Item>`);

        expect(result.getErrorString()).toBe("Later hook rejected");
        expect(observations.map(({ context }) => context.getProperty("name"))).toEqual([
            "From input",
            "Rejected input",
        ]);
        expect(h.state.get("ReferenceRecord")).toEqual(before);
        expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
    }
}, 60_000);
