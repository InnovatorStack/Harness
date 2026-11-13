import { expect, test } from "bun:test";

import { createHarness, ExecutionOutcome } from "../src/index.js";
import { observingCSharp } from "./helpers/failed-context.js";
import type { MethodContextObservation } from "./helpers/failed-context.js";
import { referenceMethod, referenceProject } from "./helpers/references.js";

function reloadThenReject(inOut: boolean): string {
    const input = inOut ? "inDom" : "this.dom";
    const original = inOut
        ? 'inDom.DocumentElement.SelectSingleNode("name").InnerText'
        : 'this.getProperty("name")';
    const result = inOut
        ? "outDom.LoadXml(inn.newResult(original).ToString());"
        : "return this.getInnovator().newResult(original);";

    return `${inOut ? "// MethodTemplateName = CSharpInOut;" : ""}
${inOut ? "var inn = new Innovator(InnovatorServerASP);" : ""}
string original = ${original};
if (original == "Reject")
{
    var holder = ${inOut ? "inn" : "this"}.newItem("ReferenceHolder", "add");
    holder.setProperty("name", "Must roll back");
    var saved = holder.apply();
    if (saved.isError()) { throw new Exception(saved.getErrorString()); }
    ${input}.LoadXml("<Item type='ReferenceRecord'><name>Changed document</name></Item>");
    throw new Exception("Rejected after reload");
}
${result}`;
}

test.each([false, true])(
    "reloaded Method input survives rejection while writes roll back and documents stay isolated: inOut=%s",
    async (inOut) => {
        await using project = await referenceProject(
            referenceMethod("ReloadThenReject", reloadThenReject(inOut)),
        );
        const observed: MethodContextObservation[] = [];
        using first = await createHarness({
            cwd: project.cwd,
            executors: [observingCSharp(observed)],
        });
        const before = first.state.get("ReferenceRecord");

        await expect(first.callMethod("ReloadThenReject", { name: "Reject" })).rejects.toThrow(
            "Rejected after reload",
        );

        expect(observed.at(-1)?.context.getProperty("name")).toBe("Changed document");
        expect(first.state.get("ReferenceHolder")).toEqual([]);
        expect(first.state.get("ReferenceRecord")).toEqual(before);
        expect(first.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);

        using second = await createHarness({ cwd: project.cwd, csharp: {} });
        expect(
            (await second.callMethod("ReloadThenReject", { name: "Other world" })).getResult(),
        ).toBe("Other world");

        await first.reset();
        expect(
            (await first.callMethod("ReloadThenReject", { name: "After reset" })).getResult(),
        ).toBe("After reset");
        expect(first.state.get("ReferenceHolder")).toEqual([]);
        expect(second.state.get("ReferenceHolder")).toEqual([]);
        expect(first.executions).toHaveLength(1);
    },
    60_000,
);
