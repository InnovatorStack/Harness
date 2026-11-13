import { expect, test } from "bun:test";

import { createHarness, ExecutionOutcome } from "../src/index.js";
import { replaceForeignDocumentItem, replaceSameDocumentItem } from "./helpers/property-items.js";
import { referenceMethod, referenceProject } from "./helpers/references.js";

test.each([
    { name: "same document", source: replaceSameDocumentItem },
    { name: "foreign document", source: replaceForeignDocumentItem },
])(
    "setPropertyItem copies its argument and preserves other native Item aliases: $name",
    async ({ source }) => {
        await using project = await referenceProject(
            referenceMethod("VerifyPropertyCopies", source),
        );
        using h = await createHarness({ cwd: project.cwd, csharp: {} });
        const before = h.state.get("ReferenceRecord");
        const result = await h.callMethod("VerifyPropertyCopies");

        expect(result.getResult()).toBe("Copies verified");
        expect(h.state.get("ReferenceRecord")).toEqual(before);
        expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.Committed);
        expect(h.executions.at(-1)?.mocks).toEqual([]);
    },
    60_000,
);

test("caught self-insertion cannot commit writes without a qualified document-alias profile", async () => {
    const source = `
var holder = this.newItem("ReferenceHolder", "add");
holder.setProperty("name", "Must roll back");
holder.apply();
try { this.setPropertyItem("self", this); }
catch (Exception) { }
return this.getInnovator().newResult("Caught unsupported insertion");`;
    await using project = await referenceProject(referenceMethod("SelfInsertion", source));
    using h = await createHarness({ cwd: project.cwd, csharp: {} });

    await expect(h.callMethod("SelfInsertion")).rejects.toThrow("document-alias support");
    expect(h.state.get("ReferenceHolder")).toEqual([]);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
}, 60_000);
