import { expect, test } from "bun:test";

import { createHarness, ExecutionOutcome, seededIds } from "../src/index.js";
import { Item } from "../src/items/item.js";
import { observingCSharp } from "./helpers/failed-context.js";
import type { MethodContextObservation } from "./helpers/failed-context.js";
import { generatedUpdateSources } from "./helpers/generated-updates.js";
import { referenceEvent, referenceMethod, referenceProject } from "./helpers/references.js";

const inspectRejected = `// MethodTemplateName = CSharpInOut;
var input = inDom.DocumentElement ?? throw new Exception("Missing input");
var original = input.SelectNodes("Relationships/Item").Cast<XmlElement>().ToArray();
try { eventData.BaseUpdateItem(outDom); }
catch (Exception) { }
var current = input.SelectNodes("Relationships/Item").Cast<XmlElement>().ToArray();
bool verified = current.Length == 2 && Object.ReferenceEquals(current[0], original[1])
    && Object.ReferenceEquals(current[1], original[0])
    && original[0].SelectSingleNode("sort_order")?.InnerText == "99";
var marker = inDom.CreateElement("verified_rejection");
marker.InnerText = verified ? "true" : "false";
input.AppendChild(marker);`;

const rejectingHook = `
var container = this.node.SelectSingleNode("Relationships");
var rows = container.SelectNodes("Item").Cast<System.Xml.XmlElement>().ToArray();
rows[0].SelectSingleNode("sort_order").InnerText = "99";
container.InsertBefore(rows[1], rows[0]);
var note = this.newItem("ReferenceHolder", "add");
note.setProperty("name", "Must roll back");
var result = note.apply();
if (result.isError()) { return result; }
`;

test.each([false, true])(
    "changed repeated requests retain origins after hook rejection and reset: throws=%s",
    async (throws) => {
        const reject = throws
            ? 'throw new Exception("Request rejected");'
            : 'return this.getInnovator().newError("Request rejected");';
        const source =
            generatedUpdateSources(true, inspectRejected) +
            referenceMethod("RejectChangedRequests", rejectingHook + reject) +
            referenceEvent("REF_RECORD", "onBeforeVersion", "RejectChangedRequests");
        const fixtures = `ReferenceFixed: [{ source_id: { name: "Parent" }, related_id: { name: "Child" }, sort_order: 7 }],`;
        await using project = await referenceProject(source, fixtures);
        const observations: MethodContextObservation[] = [];
        const options = { cwd: project.cwd, ids: seededIds("origin-rejection") };
        using h = await createHarness({ ...options, executors: [observingCSharp(observations)] });
        using other = await createHarness({ ...options, csharp: {} });
        const parent = h.state.getOne("ReferenceRecord", { name: "Parent" });
        const link = h.state.getOne("ReferenceFixed", { source_id: parent.id });
        const records = h.state.get("ReferenceRecord");
        const links = h.state.get("ReferenceFixed");
        const request = `<Item type="ReferenceRecord" action="edit" id="${parent.id}">
            <name>Rejected</name><Relationships>
                <Item type="ReferenceFixed" action="edit" id="${link.id}"><sort_order>10</sort_order></Item>
                <Item type="ReferenceFixed" action="edit" id="${link.id}"><sort_order>20</sort_order></Item>
            </Relationships></Item>`;

        for (let attempt = 0; attempt < 2; attempt += 1) {
            if (throws) {
                await expect(h.applyAML(request)).rejects.toThrow("Request rejected");
            } else {
                const result = await h.applyAML(request);
                expect(result.isError()).toBe(true);
                expect(result.getErrorString()).toContain("Request rejected");
            }

            const caller = observations.find((entry) => entry.method === "ReplaceUpdate");

            expect(caller?.context.getProperty("verified_rejection")).toBe("true");
            expect(h.state.get("ReferenceRecord")).toEqual(records);
            expect(h.state.get("ReferenceFixed")).toEqual(links);
            expect(h.state.get("ReferenceHolder")).toEqual([]);
            expect(other.state.get("ReferenceRecord")).toEqual(records);
            expect(other.state.get("ReferenceFixed")).toEqual(links);
            expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
            h.reset();
            observations.length = 0;
        }
    },
    60_000,
);

test("a retained managed Item cannot reuse an earlier invocation's origin tokens", async () => {
    const source = `
if (this.getProperty("mode") == "retain")
{
    AppDomain.CurrentDomain.SetData("request-origins-retained-item", this.getPropertyItem("value"));
    return this;
}
var held = AppDomain.CurrentDomain.GetData("request-origins-retained-item") as Item
    ?? throw new Exception("No retained Item");
this.setPropertyItem("retained", held);
return this;`;
    await using project = await referenceProject(referenceMethod("RetainRequestItem", source));
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    using other = await createHarness({ cwd: project.cwd, csharp: {} });
    const before = Item.create("Value");
    before.setProperty("name", "Before");
    const after = Item.create("Value");
    after.setProperty("name", "After");
    await h.callMethod("RetainRequestItem", { mode: "retain", value: before });
    const result = await h.callMethod("RetainRequestItem", { value: after });

    expect(result.getPropertyItem("retained")?.getProperty("name")).toBe("Before");
    expect(result.getPropertyItem("value")?.getProperty("name")).toBe("After");
    await expect(other.callMethod("RetainRequestItem", { value: after })).rejects.toThrow(
        "No retained Item",
    );
    h.reset();
    await expect(h.callMethod("RetainRequestItem", { value: after })).rejects.toThrow(
        "No retained Item",
    );
}, 60_000);
