import { expect, test } from "bun:test";

import { CapabilityId, createHarness, ExecutionOutcome } from "../src/index.js";
import { generatedUpdateSources } from "./helpers/generated-updates.js";
import { referenceEvent, referenceMethod, referenceProject } from "./helpers/references.js";

const profiles = [
    {
        name: "request root",
        source: `var replacement = this.newItem(this.getType(), this.getAction());
            replacement.setID(this.getID());
            replacement.setProperty("name", "Replaced root");
            this.loadAML(replacement.ToString());
            return this;`,
    },
    {
        name: "Item-valued property",
        source: `var replacement = this.newItem("ReferenceRecord", "get");
            replacement.setProperty("name", "Other parent");
            this.setPropertyItem("fixed_ref", replacement);
            return this;`,
    },
];

test.each(profiles)(
    "unqualified native DOM replacement fails explicitly and rolls back: $name",
    async ({ source }) => {
        const hooks =
            referenceMethod("ReplacePendingInput", source) +
            referenceEvent("REF_RECORD", "onBeforeVersion", "ReplacePendingInput");
        const delegate = "// MethodTemplateName = CSharpInOut;\neventData.BaseUpdateItem(outDom);";
        await using project = await referenceProject(
            generatedUpdateSources(true, delegate) + hooks,
        );
        using h = await createHarness({ cwd: project.cwd, csharp: {} });
        const parent = h.state.getOne("ReferenceRecord", { name: "Parent" });
        const records = h.state.get("ReferenceRecord");

        await expect(
            h.applyAML(`<Item type="ReferenceRecord" action="edit" id="${parent.id}">
            <name>Requested</name><fixed_ref><Item type="ReferenceRecord" action="get">
                <name>Child</name></Item></fixed_ref></Item>`),
        ).rejects.toMatchObject({
            code: "UnsupportedRequestIdentity",
            capability: CapabilityId.CSharp,
        });
        expect(h.state.get("ReferenceRecord")).toEqual(records);
        expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
    },
    60_000,
);
