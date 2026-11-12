import { expect, test } from "bun:test";

import { createHarness, ExecutionOutcome } from "../src/index.js";
import { referenceMethod, referenceProject } from "./helpers/references.js";
import { stateEvent } from "./helpers/state-events.js";

test("standalone CSharpInOut preserves native SOAP paging metadata through loadAML and dom", async () => {
    const source = `//MethodTemplateName=CSharpInOut;
var inn = new Innovator(InnovatorServerASP);
var query = inn.newItem("ReferenceRecord", "get");
query.setAttribute("orderBy", "name");
query.setAttribute("pagesize", "2");
var result = query.apply();
var loaded = inn.newItem();
loaded.loadAML(result.dom.OuterXml);
outDom.LoadXml(loaded.dom.OuterXml);`;
    await using project = await referenceProject(referenceMethod("InOutPaging", source));
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const response = await h.callMethod("InOutPaging");

    expect(response.getItemCount()).toBe(2);
    expect(response.payload.messages).toContainEqual({ name: "itemmax", value: "3" });
    expect(response.payload.messages).toContainEqual({ name: "pagemax", value: "2" });
}, 60_000);

test("native XML null flags clear values while preserving existing property attributes", async () => {
    const source = `//MethodTemplateName=CSharpInOut;
outDom.LoadXml("<Result><Item type='ReferenceRecord'><name>Before</name><note label='Kept'>Before</note></Item></Result>");
var item = outDom.SelectSingleNode("//Item") as XmlElement
    ?? throw new Exception("Missing result Item");
Aras.Server.Core.XML.SetItemPropertyNullInternal(item, "note", true);
Aras.Server.Core.XML.SetItemPropertyNullInternal(item, "name", false);`;
    await using project = await referenceProject(referenceMethod("NullFlags", source));
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const response = await h.callMethod("NullFlags");

    expect(response.node.properties).toMatchObject({ name: "", note: null });
    expect(response.getPropertyAttribute("note", "label")).toBe("Kept");
    expect(response.getPropertyAttribute("name", "is_null")).toBe("0");
}, 60_000);

test("CSharpInOut SOAP faults reject the owning transaction and preserve their business message", async () => {
    const source = `//MethodTemplateName=CSharpInOut;
var inn = new Innovator(InnovatorServerASP);
var item = inn.newItem("ReferenceRecord", "add");
item.setProperty("name", "Must roll back");
item.apply();
outDom.LoadXml(inn.newError("Source rejected the workflow").dom.OuterXml);`;
    await using project = await referenceProject(referenceMethod("InOutReject", source));
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const before = h.state.get("ReferenceRecord");
    const response = await h.callMethod("InOutReject");

    expect(response.getErrorString()).toBe("Source rejected the workflow");
    expect(h.state.get("ReferenceRecord")).toEqual(before);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
}, 60_000);

test("unsupported CSharpInOut result XML rolls back source writes instead of dropping data", async () => {
    const source = `//MethodTemplateName=CSharpInOut;
var inn = new Innovator(InnovatorServerASP);
var item = inn.newItem("ReferenceRecord", "add");
item.setProperty("name", "Must roll back");
item.apply();
outDom.LoadXml("<Result><Unsupported /></Result>");`;
    await using project = await referenceProject(referenceMethod("InvalidOutput", source));
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const before = h.state.get("ReferenceRecord");
    await expect(h.callMethod("InvalidOutput")).rejects.toThrow("must contain Item elements");

    expect(h.state.get("ReferenceRecord")).toEqual(before);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
}, 60_000);

test("a caught attempt to delegate another action cannot become a successful request", async () => {
    const source = `//MethodTemplateName=CSharpInOut;
inDom.DocumentElement.SetAttribute("action", "delete");
try
{
    eventData.BaseLockItem(outDom);
}
catch (Exception)
{
    outDom.LoadXml("<Result>caught</Result>");
}`;
    await using project = await referenceProject(stateEvent("onLock", "WrongBase", source));
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const parent = await h.getOne("ReferenceRecord", { name: "Parent" });
    const before = h.state.get("ReferenceRecord");
    await expect(
        h.applyAML(`<Item type="ReferenceRecord" action="lock" id="${parent.id}" />`),
    ).rejects.toThrow("must retain the replacement ItemType and action");

    expect(h.state.get("ReferenceRecord")).toEqual(before);
}, 60_000);

test("unknown native template directives fail explicitly without default-template fallback", async () => {
    const source = "//MethodTemplateName=UnavailableTemplate;\nreturn this;";
    await using project = await referenceProject(referenceMethod("UnknownTemplate", source));
    using h = await createHarness({ cwd: project.cwd, csharp: {} });

    await expect(h.callMethod("UnknownTemplate")).rejects.toMatchObject({
        code: "UnsupportedMethodTemplate",
    });
    expect(h.executions.at(-1)?.calls[0]?.executed).not.toBe(true);
}, 60_000);
