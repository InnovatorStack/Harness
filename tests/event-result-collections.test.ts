import { expect, test } from "bun:test";

import { createHarness, ExecutionOutcome } from "../src/index.js";
import { referenceEvent, referenceMethod, referenceProject } from "./helpers/references.js";

const mutateRows = `
for (int index = 0; index < this.getItemCount(); index++)
{
    this.getItemByIndex(index).setProperty("name", "From input");
}
return this.getInnovator().newResult("Unrelated response");`;

const validateRows = `
for (int index = 0; index < this.getItemCount(); index++)
{
    var row = this.getItemByIndex(index);
    if (row.getProperty("name") != "From input")
    {
        throw new Exception("After-Get lost the shared result input");
    }
    row.setProperty("name", "Validated input");
}
return this.getInnovator().newResult("Another unrelated response");`;

test("after-Get bindings share the actual result collection while their separate responses stay unused", async () => {
    await using project = await referenceProject(
        referenceMethod("MutateResultRows", mutateRows) +
            referenceEvent("REF_RECORD", "onAfterGet", "MutateResultRows", { order: 10 }) +
            referenceMethod("ValidateResultRows", validateRows) +
            referenceEvent("REF_RECORD", "onAfterGet", "ValidateResultRows", { order: 20 }),
    );
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const before = h.state.get("ReferenceRecord");
    const result = await h.applyAML('<Item type="ReferenceRecord" action="get" select="name" />');

    expect(result.getItemCount()).toBe(3);
    expect(result.payload.items.every((node) => node.properties.name === "Validated input")).toBe(
        true,
    );
    expect(h.trace.filter((entry) => entry.kind === "method").map((entry) => entry.name)).toEqual([
        "MutateResultRows",
        "ValidateResultRows",
    ]);
    expect(h.state.get("ReferenceRecord")).toEqual(before);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.Committed);
}, 60_000);

test("after-Get preserves actual paging metadata while an ordinary Method retains its own metadata", async () => {
    const source = `// MethodTemplateName = CSharpInOut;
outDom.LoadXml("<SOAP-ENV:Envelope xmlns:SOAP-ENV='http://schemas.xmlsoap.org/soap/envelope/'><SOAP-ENV:Body><Result>Response only</Result><Message><event name='itemmax' value='999' /><event name='pagemax' value='999' /></Message></SOAP-ENV:Body></SOAP-ENV:Envelope>");`;
    await using project = await referenceProject(
        referenceMethod("ReturnPagingResponse", source) +
            referenceEvent("REF_RECORD", "onAfterGet", "ReturnPagingResponse"),
    );
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const before = h.state.get("ReferenceRecord");
    const page = await h.applyAML(
        '<Item type="ReferenceRecord" action="get" orderBy="name" pagesize="2" />',
    );

    expect(page.getItemCount()).toBe(2);
    expect(page.payload.messages).toEqual([
        { name: "itemmax", value: "3" },
        { name: "pagemax", value: "2" },
    ]);
    const direct = await h.callMethod("ReturnPagingResponse");

    expect(direct.getResult()).toBe("Response only");
    expect(direct.payload.messages).toEqual([
        { name: "itemmax", value: "999" },
        { name: "pagemax", value: "999" },
    ]);
    expect(h.state.get("ReferenceRecord")).toEqual(before);
}, 60_000);
