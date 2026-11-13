import { expect, test } from "bun:test";

import { createHarness, ExecutionOutcome } from "../src/index.js";
import { referenceEvent, referenceMethod, referenceProject } from "./helpers/references.js";

test("a caught document reload cannot commit unqualified version-generation reentry", async () => {
    const source = `
var holder = this.newItem("ReferenceHolder", "add");
holder.setProperty("name", "Must roll back");
var saved = holder.apply();
if (saved.isError()) { return saved; }
string id = this.getID();
this.loadAML("<Item type='ReferenceRecord' action='update' id='" + id + "'><name>Replaced</name></Item>");
try { eventData.BaseUpdateItem(new System.Xml.XmlDocument()); }
catch (Exception) { }
return this.getInnovator().newResult("Caught unsupported input reload");`;
    const methods =
        referenceMethod("ReloadBeforeBase", source) +
        referenceEvent("REF_RECORD", "onUpdate", "ReloadBeforeBase");
    await using project = await referenceProject(methods);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const record = h.state.getOne("ReferenceRecord", { name: "Parent" });
    const records = h.state.get("ReferenceRecord");

    await expect(
        h.applyAML(`<Item type="ReferenceRecord" action="edit" id="${record.id}">
                <name>Requested</name></Item>`),
    ).rejects.toThrow("Version-generation reentry");
    expect(h.state.get("ReferenceHolder")).toEqual([]);
    expect(h.state.get("ReferenceRecord")).toEqual(records);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
}, 60_000);

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
