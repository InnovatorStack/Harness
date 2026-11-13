import { expect, test } from "bun:test";

import { CapabilityId, createHarness, ExecutionOutcome } from "../src/index.js";
import { generatedUpdateSources } from "./helpers/generated-updates.js";
import { referenceEvent, referenceMethod, referenceProject } from "./helpers/references.js";

const fixtures = `ReferenceFixed: [
    { source_id: { name: "Parent" }, related_id: { name: "Child" }, sort_order: 1 },
    { source_id: { name: "Parent" }, related_id: { name: "Other parent" }, sort_order: 2 },
],`;

const replacement = `// MethodTemplateName = CSharpInOut;
var input = inDom.DocumentElement ?? throw new Exception("Missing input");
bool initial = !input.HasAttribute("oldId");
var container = input.SelectSingleNode("Relationships");
var original = container?.SelectNodes("Item").Cast<XmlElement>().ToArray()
    ?? Array.Empty<XmlElement>();
string name = input.SelectSingleNode("name")?.InnerText ?? "";
eventData.BaseUpdateItem(outDom);
if (initial && name == "Remove container")
{
    if (input.SelectSingleNode("Relationships") != null || container.ParentNode != null)
    {
        throw new Exception("The removed pending container remained attached");
    }
}
else if (initial)
{
    var current = container.SelectNodes("Item").Cast<XmlElement>().ToArray();
    if (!Object.ReferenceEquals(container, input.SelectSingleNode("Relationships")))
    {
        throw new Exception("The pending relationship container was replaced");
    }
    if (name == "Remove first")
    {
        if (current.Length != 1 || original[0].ParentNode != null
            || !Object.ReferenceEquals(original[1], current[0]))
        {
            throw new Exception("Removing one request changed the surviving node's identity");
        }
    }
    else if (name == "Reorder")
    {
        if (current.Length != 2 || !Object.ReferenceEquals(original[1], current[0])
            || !Object.ReferenceEquals(original[0], current[1]))
        {
            throw new Exception("Reordered requests lost their original XML nodes");
        }
    }
    else if (name == "Empty")
    {
        if (current.Length != 0 || original.Any(row => row.ParentNode != null))
        {
            throw new Exception("The empty pending container lost its original XML identity");
        }
    }
}`;

const beforeVersion = `
var container = this.node.SelectSingleNode("Relationships");
var rows = container.SelectNodes("Item").Cast<System.Xml.XmlElement>().ToArray();
if (this.getProperty("name") == "Remove first") { container.RemoveChild(rows[0]); }
if (this.getProperty("name") == "Reorder") { container.InsertBefore(rows[1], rows[0]); }
if (this.getProperty("name") == "Empty") { foreach (var row in rows) { container.RemoveChild(row); } }
if (this.getProperty("name") == "Remove container") { this.removeProperty("Relationships"); }
return this;`;

test.each([
    { name: "Remove first", expected: [1, 20] },
    { name: "Reorder", expected: [10, 20] },
    { name: "Empty", expected: [1, 2] },
    { name: "Remove container", expected: [1, 2] },
])(
    "native copy identities retain XML views when a real hook changes request order: %j",
    async ({ name, expected }) => {
        const source =
            referenceMethod("ChangePendingRelationships", beforeVersion) +
            referenceEvent("REF_RECORD", "onBeforeVersion", "ChangePendingRelationships");
        await using project = await referenceProject(
            generatedUpdateSources(true, replacement) + source,
            fixtures,
        );
        using h = await createHarness({ cwd: project.cwd, csharp: {} });
        const parent = await h.getOne("ReferenceRecord", { name: "Parent" });
        const first = h.state.getOne("ReferenceFixed", { sort_order: 1 });
        const second = h.state.getOne("ReferenceFixed", { sort_order: 2 });
        const result =
            await h.applyAML(`<Item type="ReferenceRecord" action="edit" id="${parent.id}"><name>${name}</name>
        <Relationships>
            <Item type="ReferenceFixed" action="edit" id="${first.id}"><sort_order>10</sort_order></Item>
            <Item type="ReferenceFixed" action="edit" id="${second.id}"><sort_order>20</sort_order></Item>
        </Relationships></Item>`);
        const copied = h.state.get("ReferenceFixed", { source_id: result.getID() });

        expect(result.isError()).toBe(false);
        expect(
            copied
                .map((record) => record.properties.sort_order)
                .sort((a, b) => Number(a) - Number(b)),
        ).toEqual([...expected]);
        expect(h.state.getOne("ReferenceFixed", { id: first.id }).properties.sort_order).toBe(1);
        expect(h.state.getOne("ReferenceFixed", { id: second.id }).properties.sort_order).toBe(2);
        expect(h.executions.at(-1)?.mocks).toEqual([]);
    },
    60_000,
);

test("ambiguous repeated-ID edits report their missing identity profile instead of changing another view", async () => {
    const hook =
        referenceMethod(
            "ChangeRepeatedRequest",
            'this.node.SelectSingleNode("Relationships/Item/sort_order").InnerText = "99"; return this;',
        ) + referenceEvent("REF_RECORD", "onBeforeVersion", "ChangeRepeatedRequest");
    const delegate = "// MethodTemplateName = CSharpInOut;\neventData.BaseUpdateItem(outDom);";
    await using project = await referenceProject(
        generatedUpdateSources(true, delegate) + hook,
        fixtures,
    );
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const parent = await h.getOne("ReferenceRecord", { name: "Parent" });
    const first = h.state.getOne("ReferenceFixed", { sort_order: 1 });
    const records = h.state.get("ReferenceRecord");
    const links = h.state.get("ReferenceFixed");

    await expect(
        h.applyAML(`<Item type="ReferenceRecord" action="edit" id="${parent.id}"><name>Repeated request</name>
        <Relationships>
            <Item type="ReferenceFixed" action="edit" id="${first.id}"><sort_order>10</sort_order></Item>
            <Item type="ReferenceFixed" action="edit" id="${first.id}"><sort_order>20</sort_order></Item>
        </Relationships></Item>`),
    ).rejects.toMatchObject({
        code: "UnsupportedRequestIdentity",
        capability: CapabilityId.CSharp,
    });
    expect(h.state.get("ReferenceRecord")).toEqual(records);
    expect(h.state.get("ReferenceFixed")).toEqual(links);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
}, 60_000);
