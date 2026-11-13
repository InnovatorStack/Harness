import { expect, test } from "bun:test";

import { createHarness, ExecutionOutcome, seededIds } from "../src/index.js";
import { observingCSharp } from "./helpers/failed-context.js";
import type { MethodContextObservation } from "./helpers/failed-context.js";
import { generatedUpdateSources } from "./helpers/generated-updates.js";
import { referenceProject } from "./helpers/references.js";

const source = `// MethodTemplateName = CSharpInOut;
var input = inDom.DocumentElement ?? throw new Exception("Missing input");
if (input.HasAttribute("oldId"))
{
    eventData.BaseUpdateItem(outDom);
    var attempted = inDom.CreateElement("attempted");
    attempted.InnerText = "After generated base";
    input.AppendChild(attempted);
    throw new Exception("Generated replacement rejected");
}
try { eventData.BaseUpdateItem(outDom); }
catch (Exception)
{
    var verified = inDom.CreateElement("caller_verified");
    verified.InnerText = input.SelectSingleNode("attempted")?.InnerText == "After generated base"
        && input.GetAttribute("id") != input.GetAttribute("oldId") ? "true" : "false";
    input.AppendChild(verified);
}`;

test("a generated replacement failure forwards its latest input through the outer base call", async () => {
    await using project = await referenceProject(generatedUpdateSources(false, source));
    const observations: MethodContextObservation[] = [];
    using h = await createHarness({
        cwd: project.cwd,
        executors: [observingCSharp(observations)],
        ids: seededIds("failed-generated-input"),
    });
    using other = await createHarness({
        cwd: project.cwd,
        csharp: {},
        ids: seededIds("failed-generated-input"),
    });
    const parent = await h.getOne("ReferenceRecord", { name: "Parent" });
    const before = h.state.get("ReferenceRecord");

    await expect(h.update(parent, { name: "Attempted save" })).rejects.toThrow(
        "Generated replacement rejected",
    );
    const replacements = observations.filter((entry) => entry.method === "ReplaceUpdate");
    const inner = replacements[0]?.context;
    const outer = replacements[1]?.context;

    expect(replacements).toHaveLength(2);
    expect(inner?.getProperty("attempted")).toBe("After generated base");
    expect(outer?.getProperty("attempted")).toBe("After generated base");
    expect(outer?.getProperty("caller_verified")).toBe("true");
    expect(outer?.getID()).toBe(inner?.getID());
    expect(outer?.getID()).not.toBe(parent.id);
    expect(h.state.get("ReferenceRecord")).toEqual(before);
    expect(other.state.get("ReferenceRecord")).toEqual(before);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
    expect(h.executions.at(-1)?.changes.filter((change) => change.name === "version")).toHaveLength(
        1,
    );
    expect(h.executions.at(-1)?.changes.filter((change) => change.name === "update")).toHaveLength(
        1,
    );
    const attemptedId = inner?.getID();
    h.reset();
    observations.length = 0;

    await expect(h.update(parent, { name: "Attempted save" })).rejects.toThrow(
        "Generated replacement rejected",
    );
    expect(observations.at(-1)?.context.getID()).toBe(attemptedId);
    expect(observations.at(-1)?.context.getProperty("caller_verified")).toBe("true");
    expect(h.state.get("ReferenceRecord")).toEqual(before);
    expect(other.state.get("ReferenceRecord")).toEqual(before);
}, 60_000);
