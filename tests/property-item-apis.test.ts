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

test("self-insertion rebinds the argument while retaining the parent document and aliases", async () => {
    const source = `
this.setProperty("name", "Parent");
var original = this.node;
var document = this.dom;
var alias = this.getItemsByXPath("/Item");
var inserted = this.setPropertyItem("self", this);
this.setProperty("name", "Child");
if (!Object.ReferenceEquals(this, inserted)
    || !Object.ReferenceEquals(document.DocumentElement, original)
    || !Object.ReferenceEquals(alias.node, original)
    || Object.ReferenceEquals(this.node, original)
    || !Object.ReferenceEquals(document, this.dom)
    || alias.getProperty("name") != "Parent"
    || this.getProperty("name") != "Child")
{
    throw new Exception("Self-insertion lost the parent or argument view");
}
return this;`;
    await using project = await referenceProject(referenceMethod("SelfInsertion", source));
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const before = h.state.get("ReferenceRecord");
    const result = await h.callMethod("SelfInsertion");

    expect(result.getProperty("name")).toBe("Parent");
    expect(result.getPropertyItem("self")?.getProperty("name")).toBe("Child");
    expect(h.state.get("ReferenceRecord")).toEqual(before);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.Committed);
}, 60_000);
