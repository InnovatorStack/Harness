import { expect, test } from "bun:test";

import { createHarness, ExecutionOutcome } from "../src/index.js";
import {
    applyCollectionSelection,
    inspectDocumentFields,
    inspectLiveDocument,
    reloadCollectionDocument,
    reloadRawInput,
    reloadSharedDocument,
    rejectDetachedActions,
    returnCollectionView,
} from "./helpers/document-views.js";
import { observingCSharp } from "./helpers/failed-context.js";
import type { MethodContextObservation } from "./helpers/failed-context.js";
import { referenceMethod, referenceProject } from "./helpers/references.js";

test.each([
    { name: "shared nested Item", source: reloadSharedDocument },
    { name: "collection", source: reloadCollectionDocument },
    { name: "scalar and fault", source: inspectLiveDocument },
    { name: "independent document and selection fields", source: inspectDocumentFields },
    { name: "detached document-bound operations", source: rejectDetachedActions },
])(
    "native Item selections remain separate from their shared document: $name",
    async ({ source }) => {
        await using project = await referenceProject(
            referenceMethod("VerifyDocumentViews", source),
        );
        using h = await createHarness({ cwd: project.cwd, csharp: {} });
        const before = h.state.get("ReferenceRecord");
        const result = await h.callMethod("VerifyDocumentViews");

        expect(result.getResult()).toBe("Document views verified");
        expect(h.state.get("ReferenceRecord")).toEqual(before);
        expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.Committed);
        expect(h.executions.at(-1)?.mocks).toEqual([]);
    },
    60_000,
);

test("returning a selected Item retains ownership of its whole response document", async () => {
    await using project = await referenceProject(
        referenceMethod("ReturnSelectedView", returnCollectionView),
    );
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const result = await h.callMethod("ReturnSelectedView");

    expect(result.payload.items.map((node) => node.properties.name)).toEqual(["First", "Second"]);
}, 60_000);

test("raw input reload changes the Method document while its retained selection stays detached", async () => {
    await using project = await referenceProject(referenceMethod("ReloadRawInput", reloadRawInput));
    const observed: MethodContextObservation[] = [];
    using h = await createHarness({
        cwd: project.cwd,
        executors: [observingCSharp(observed)],
    });
    const result = await h.callMethod("ReloadRawInput", { name: "Original" });

    expect(result.getResult()).toBe("Document views verified");
    expect(observed[0]?.context.getProperty("name")).toBe("From document");
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.Committed);
}, 60_000);

test("applying a collection selection writes only the selected Item", async () => {
    await using project = await referenceProject(
        referenceMethod("ApplySelectedView", applyCollectionSelection),
        'ReferenceHolder: [{ name: "First" }, { name: "Second" }],',
    );
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const original = h.state.getOne("ReferenceHolder", { name: "First" });
    const second = h.state.getOne("ReferenceHolder", { name: "Second" });
    const result = await h.callMethod("ApplySelectedView");

    expect(result.getItemCount()).toBe(1);
    expect(result.getID()).toBe(original.id);
    expect(h.state.getOne("ReferenceHolder", { name: "Changed first" }).id).toBe(original.id);
    expect(h.state.getOne("ReferenceHolder", { name: "Second" })).toEqual(second);
    expect(
        h.executions.at(-1)?.changes.filter((change) => change.after?.type === "ReferenceHolder"),
    ).toHaveLength(1);
}, 60_000);

test("assigning a separate Method document preserves its captured input document", async () => {
    const source = `
this.setProperty("name", "Shared input");
var output = this.newItem("ReferenceRecord");
output.setProperty("name", "Separate output");
this.dom = output.dom;
this.node = output.node;
return this;`;
    await using project = await referenceProject(referenceMethod("ReplaceMethodDocument", source));
    const observed: MethodContextObservation[] = [];
    using h = await createHarness({
        cwd: project.cwd,
        executors: [observingCSharp(observed)],
    });
    const result = await h.callMethod("ReplaceMethodDocument", { name: "Original" });

    expect(result.getProperty("name")).toBe("Separate output");
    expect(observed[0]?.context.getProperty("name")).toBe("Shared input");
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.Committed);
}, 60_000);
