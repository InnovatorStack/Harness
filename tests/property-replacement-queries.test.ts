import { expect, test } from "bun:test";

import { createHarness, ExecutionOutcome } from "../src/index.js";
import {
    nestedPropertyReplacement,
    replaceNestedPropertyInput,
} from "./helpers/property-replacements.js";
import { referenceEvent, referenceMethod, referenceProject } from "./helpers/references.js";

test.each(["CSharp", "CSharpInOut"] as const)(
    "base Get synchronizes a replaced Item nested under another property through %s",
    async (template) => {
        const source =
            referenceMethod("ReplaceNestedCriteria", replaceNestedPropertyInput) +
            referenceEvent("REF_RECORD", "onBeforeGet", "ReplaceNestedCriteria") +
            referenceMethod("VerifyNestedReplacement", nestedPropertyReplacement(template)) +
            referenceEvent("REF_RECORD", "onGet", "VerifyNestedReplacement");
        await using project = await referenceProject(source);
        using h = await createHarness({ cwd: project.cwd, csharp: {} });
        const before = h.state.get("ReferenceRecord");
        const result = await h.applyAML(`<Item type="ReferenceRecord" action="get">
            <name>Missing</name><fixed_ref><Item type="ReferenceRecord" action="get">
                <float_ref><Item type="ReferenceRecord" action="get"><name>Child</name></Item></float_ref>
            </Item></fixed_ref></Item>`);

        expect(result.getErrorCode()).toBe("0");
        expect(h.state.get("ReferenceRecord")).toEqual(before);
        expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.Committed);
        expect(h.executions.at(-1)?.mocks).toEqual([]);
    },
    60_000,
);
