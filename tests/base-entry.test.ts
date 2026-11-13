import { expect, test } from "bun:test";

import { createHarness, ExecutionOutcome, seededIds } from "../src/index.js";
import { baseEntryMethods } from "./helpers/base-entry.js";
import { referenceEvent, referenceMethod, referenceProject } from "./helpers/references.js";

const profiles = ["CSharp", "CSharpInOut"].flatMap((template) => [
    { template, verb: "Get" as const },
    { template, verb: "Update" as const },
]);

test.each(profiles)(
    "$template Base$verb separates its captured request from an earlier document reload",
    async ({ template, verb }) => {
        await using project = await referenceProject(
            baseEntryMethods(verb, template),
            'ReferenceHolder: [{ name: "Captured value" }],',
        );
        using h = await createHarness({ cwd: project.cwd, csharp: {} });
        const original = h.state.getOne("ReferenceHolder", { name: "Captured value" });
        const other = h.state.get("ReferenceRecord");
        const result = await h.applyAML(
            `<Item type="ReferenceHolder" action="${verb.toLowerCase()}" id="${original.id}">
                <name>Requested</name></Item>`,
        );

        expect(result.isError()).toBe(false);
        expect(result.getID()).toBe(original.id);
        expect(result.getProperty("name")).toBe(verb === "Get" ? "Captured value" : "Saved value");
        expect(h.state.get("ReferenceRecord")).toEqual(other);
        expect(h.state.getOne("ReferenceHolder", { id: original.id }).properties.name).toBe(
            verb === "Get" ? "Captured value" : "Saved value",
        );
        expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.Committed);
        expect(h.executions.at(-1)?.mocks).toEqual([]);
    },
    60_000,
);

test("a version-suppressed update uses captured data without replacing its generation", async () => {
    const source = `
var selected = this.node;
this.setProperty("name", "Captured value");
this.loadAML("<Item type='ReferenceHolder' action='add'><name>Current document</name></Item>");
var current = this.node;
var output = new System.Xml.XmlDocument();
eventData.BaseUpdateItem(output);
if (!Object.ReferenceEquals(current, this.dom.DocumentElement)
    || this.getProperty("name") != "Current document"
    || selected.SelectSingleNode("name").InnerText != "Captured value")
{
    throw new Exception("BaseUpdate confused captured and current input");
}
var result = this.newItem();
result.loadAML(output.OuterXml);
return result;`;
    const methods =
        referenceMethod("ReloadVersionedEntry", source) +
        referenceEvent("REF_RECORD", "onUpdate", "ReloadVersionedEntry") +
        referenceMethod(
            "SaveVersionedEntry",
            'this.setProperty("name", "Saved value"); return this;',
        ) +
        referenceEvent("REF_RECORD", "onBeforeUpdate", "SaveVersionedEntry");
    await using project = await referenceProject(methods);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const original = h.state.getOne("ReferenceRecord", { name: "Parent" });
    await h.applyAML(`<Item type="ReferenceRecord" action="lock" id="${original.id}" />`);
    const result = await h.applyAML(`<Item type="ReferenceRecord" action="update"
        version="0" id="${original.id}"><name>Requested</name></Item>`);

    expect(result.isError()).toBe(false);
    expect(result.getID()).toBe(original.id);
    expect(h.state.get("ReferenceRecord")).toHaveLength(3);
    expect(h.state.getOne("ReferenceRecord", { id: original.id }).properties).toMatchObject({
        name: "Saved value",
        generation: 1,
        config_id: original.properties.config_id,
    });
    expect(h.state.get("ReferenceHolder")).toEqual([]);
}, 60_000);

test("a later hook reload retains both earlier input elements and their independent views", async () => {
    const delegate = `
var captured = this.node;
this.setProperty("name", "Captured value");
this.loadAML("<Item type='ReferenceRecord' action='get'><name>Current document</name></Item>");
var current = this.node;
var name = current.SelectSingleNode("name");
var text = name.FirstChild;
var output = new System.Xml.XmlDocument();
eventData.BaseGetItem(output);
if (captured.ParentNode != null || captured.SelectSingleNode("name").InnerText != "Captured value"
    || current.ParentNode != null || name.InnerText != "Detached current document"
    || !Object.ReferenceEquals(text, name.FirstChild)
    || !Object.ReferenceEquals(name, current.SelectSingleNode("name"))
    || this.dom.DocumentElement.SelectSingleNode("name").InnerText != "Later document")
{
    throw new Exception("BaseGet merged or discarded one of its independent input views");
}
var result = this.newItem();
result.loadAML(output.OuterXml);
return result;`;
    const reload = `
var previous = this.node;
this.loadAML("<Item type='ReferenceRecord' action='get'><name>Later document</name></Item>");
previous.SelectSingleNode("name").InnerText = "Detached current document";
return this;`;
    const methods =
        referenceMethod("RetainEntryViews", delegate) +
        referenceEvent("REF_HOLDER", "onGet", "RetainEntryViews") +
        referenceMethod("ReloadEntryAgain", reload) +
        referenceEvent("REF_HOLDER", "onBeforeGet", "ReloadEntryAgain");
    await using project = await referenceProject(
        methods,
        'ReferenceHolder: [{ name: "Captured value" }],',
    );
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const before = h.state.get("ReferenceHolder");
    const result = await h.getOne("ReferenceHolder", { name: "Requested" });

    expect(result.properties.name).toBe("Captured value");
    expect(h.state.get("ReferenceHolder")).toEqual(before);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.Committed);
}, 60_000);

test("moving the separately retained current Item into another container stays guarded", async () => {
    const delegate = `
this.loadAML("<Item type='ReferenceRecord' action='get'><name>Current document</name></Item>");
try { eventData.BaseGetItem(new System.Xml.XmlDocument()); }
catch (Exception) { }
return this.getInnovator().newResult("Caught moved document");`;
    const move = `
var saved = this.getInnovator().applyAML(
    "<Item type='ReferenceRecord' action='add'><name>Must roll back</name></Item>");
if (saved.isError()) { return saved; }
var current = this.dom.DocumentElement;
this.dom.RemoveChild(current);
var wrapper = this.dom.CreateElement("AML");
this.dom.AppendChild(wrapper);
wrapper.AppendChild(current);
return this;`;
    const methods =
        referenceMethod("CatchMovedEntry", delegate) +
        referenceEvent("REF_HOLDER", "onGet", "CatchMovedEntry") +
        referenceMethod("MoveEntryDocument", move) +
        referenceEvent("REF_HOLDER", "onBeforeGet", "MoveEntryDocument");
    await using project = await referenceProject(
        methods,
        'ReferenceHolder: [{ name: "Captured value" }],',
    );
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const original = h.state.get("ReferenceRecord");

    await expect(h.getOne("ReferenceHolder", { name: "Requested" })).rejects.toThrow(
        "Moving retained input Items",
    );
    expect(h.state.get("ReferenceRecord")).toEqual(original);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
}, 60_000);

test("a rejecting Get hook synchronizes the current document and rolls back nested writes", async () => {
    const source = `
var saved = this.getInnovator().applyAML(
    "<Item type='ReferenceRecord' action='add'><name>Must roll back</name></Item>");
if (saved.isError()) { return saved; }
return this.getInnovator().newError("Rejected captured Get");`;
    const methods =
        baseEntryMethods("Get", "CSharp") +
        referenceMethod("RejectCapturedGet", source) +
        referenceEvent("REF_HOLDER", "onBeforeGet", "RejectCapturedGet", { order: 20 });
    await using project = await referenceProject(
        methods,
        'ReferenceHolder: [{ name: "Captured value" }],',
    );
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const original = h.state.getOne("ReferenceHolder", { name: "Captured value" });
    const records = h.state.get("ReferenceRecord");
    const result = await h.applyAML(`<Item type="ReferenceHolder" action="get"
        id="${original.id}"><name>Requested</name></Item>`);

    expect(result.isError()).toBe(true);
    expect(result.getErrorString()).toBe("Rejected captured Get");
    expect(h.state.get("ReferenceRecord")).toEqual(records);
    expect(h.state.getOne("ReferenceHolder", { id: original.id })).toEqual(original);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
});

test("captured entry documents stay isolated after reset and across independent worlds", async () => {
    await using project = await referenceProject(
        baseEntryMethods("Get", "CSharp"),
        'ReferenceHolder: [{ name: "Captured value" }],',
    );
    const options = { cwd: project.cwd, csharp: {}, ids: seededIds("base-entry") };
    using first = await createHarness(options);
    using second = await createHarness(options);
    const left = await first.getOne("ReferenceHolder", { name: "Requested" });
    const right = await second.getOne("ReferenceHolder", { name: "Requested" });
    const original = second.state.get("ReferenceHolder");

    expect(left.id).toBe(right.id);
    first.reset();
    expect(first.executions).toEqual([]);
    expect(second.executions).toHaveLength(1);
    expect(second.state.get("ReferenceHolder")).toEqual(original);
    const repeated = await first.getOne("ReferenceHolder", { name: "Requested" });

    expect(repeated.id).toBe(left.id);
    expect(repeated.properties.name).toBe("Captured value");
});

test.each([false, true])(
    "a nonversionable base update retains its selected target and flags: reload=%s",
    async (reload) => {
        const changeDocument = reload
            ? `this.loadAML("<Item type='ReferenceRecord' action='add'><name>Unrelated</name></Item>");`
            : "";
        const source = `
var selected = this.node;
var query = this.newItem("ReferenceHolder", "get");
query.setProperty("name", "Other target");
var other = query.apply();
if (other.isError()) { return other; }
selected.SetAttribute("id", other.getID());
selected.SetAttribute("serverEvents", "0");
selected.SetAttribute("doGetItem", "0");
selected.SelectSingleNode("name").InnerText = "Captured value";
${changeDocument}
var output = new System.Xml.XmlDocument();
eventData.BaseUpdateItem(output);
if (selected.GetAttribute("id") != other.getID()
    || selected.GetAttribute("serverEvents") != "0"
    || selected.GetAttribute("doGetItem") != "0")
{
    throw new Exception("The default action rewrote replacement-owned XML attributes");
}
var result = this.newItem();
result.loadAML(output.OuterXml);
if (result.getProperty("name") != "Saved by before hook")
{
    throw new Exception("The captured event or response flag was not retained");
}
return result;`;
        const methods =
            referenceMethod("ChangeBaseTarget", source) +
            referenceEvent("REF_HOLDER", "onUpdate", "ChangeBaseTarget") +
            referenceMethod(
                "SaveBaseTarget",
                'this.setProperty("name", "Saved by before hook"); return this;',
            ) +
            referenceEvent("REF_HOLDER", "onBeforeUpdate", "SaveBaseTarget");
        await using project = await referenceProject(
            methods,
            'ReferenceHolder: [{ name: "Original" }, { name: "Other target" }],',
        );
        using h = await createHarness({ cwd: project.cwd, csharp: {} });
        const original = h.state.getOne("ReferenceHolder", { name: "Original" });
        const other = h.state.getOne("ReferenceHolder", { name: "Other target" });
        const result = await h.update(original, { name: "Requested" });

        expect(result.id).toBe(original.id);
        expect(result.properties.name).toBe("Saved by before hook");
        expect(h.state.getOne("ReferenceHolder", { id: other.id })).toEqual(other);
        expect(h.state.getOne("ReferenceHolder", { id: original.id }).properties.name).toBe(
            "Saved by before hook",
        );
    },
    60_000,
);
