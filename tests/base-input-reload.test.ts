import { expect, test } from "bun:test";

import { createHarness, ExecutionOutcome } from "../src/index.js";
import { referenceEvent, referenceMethod, referenceProject } from "./helpers/references.js";

test.each(["Get", "Update"])(
    "a caught input reload before Base%s cannot commit an unqualified native action",
    async (verb) => {
        const action = verb.toLowerCase();
        const source = `
var holder = this.newItem("ReferenceRecord", "add");
holder.setProperty("name", "Must roll back");
var saved = holder.apply();
if (saved.isError()) { return saved; }
string id = this.getID();
this.loadAML("<Item type='ReferenceHolder' action='${action}' id='" + id + "'><name>Replaced</name></Item>");
try { eventData.Base${verb}Item(new System.Xml.XmlDocument()); }
catch (Exception) { }
return this.getInnovator().newResult("Caught unsupported input reload");`;
        const methods =
            referenceMethod("ReloadBeforeBase", source) +
            referenceEvent("REF_HOLDER", `on${verb}`, "ReloadBeforeBase");
        await using project = await referenceProject(
            methods,
            'ReferenceHolder: [{ name: "Original" }],',
        );
        using h = await createHarness({ cwd: project.cwd, csharp: {} });
        const record = h.state.getOne("ReferenceHolder", { name: "Original" });
        const before = h.state.get("ReferenceHolder");
        const records = h.state.get("ReferenceRecord");

        await expect(
            h.applyAML(`<Item type="ReferenceHolder" action="${action}" id="${record.id}">
                <name>Requested</name></Item>`),
        ).rejects.toThrow("captured request node and current document");
        expect(h.state.get("ReferenceHolder")).toEqual(before);
        expect(h.state.get("ReferenceRecord")).toEqual(records);
        expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
    },
    60_000,
);

test("BaseAdd uses the document reparsed after the replacement Method reloads it", async () => {
    const source = `
this.loadAML("<Item type='ReferenceHolder' action='add'><name>Replacement document</name></Item>");
var output = new System.Xml.XmlDocument();
eventData.BaseAddItem(output);
var result = this.newItem();
result.loadAML(output.OuterXml);
return result;`;
    const methods =
        referenceMethod("ReloadBeforeAdd", source) +
        referenceEvent("REF_HOLDER", "onAdd", "ReloadBeforeAdd");
    await using project = await referenceProject(methods);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const result = await h.add("ReferenceHolder", { name: "Original document" });

    expect(h.state.getOne("ReferenceHolder", { id: result.id }).properties.name).toBe(
        "Replacement document",
    );
    expect(h.state.get("ReferenceHolder")).toHaveLength(1);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.Committed);
}, 60_000);
