import { expect, test } from "bun:test";

import { createHarness, ExecutionOutcome } from "../src/index.js";
import { generatedUpdateSources } from "./helpers/generated-updates.js";
import { referenceEvent, referenceMethod, referenceProject } from "./helpers/references.js";

const replacement = `// MethodTemplateName = CSharpInOut;
var input = inDom.DocumentElement ?? throw new Exception("Missing input");
bool initial = !input.HasAttribute("oldId");
var container = input.SelectSingleNode("Relationships");
var original = container.SelectNodes("Item").Cast<XmlElement>().ToArray();
eventData.BaseUpdateItem(outDom);
if (initial)
{
    var current = container.SelectNodes("Item").Cast<XmlElement>().ToArray();
    bool remove = input.SelectSingleNode("name")?.InnerText == "Remove";
    if (current.Length != (remove ? 1 : 2) || original[0].ParentNode != null
        || !Object.ReferenceEquals(current[0], original[1]))
    {
        throw new Exception("Removal changed the surviving request's XML origin");
    }
    if (!remove && (Object.ReferenceEquals(current[1], original[0])
        || current[1].SelectSingleNode("sort_order")?.InnerText != "10"))
    {
        throw new Exception("An identical replacement reused the removed XML node");
    }
}`;

const mutate = `
var container = this.node.SelectSingleNode("Relationships");
var rows = container.SelectNodes("Item").Cast<System.Xml.XmlElement>().ToArray();
container.RemoveChild(rows[0]);
if (this.getProperty("name") == "Remove")
{
    rows[1].SelectSingleNode("sort_order").InnerText = "99";
}
else
{
    container.AppendChild(rows[0].CloneNode(true));
}
return this;`;

const profiles = [false, true].flatMap((repeated) =>
    ["Remove", "Replace"].map((name) => ({ repeated, name })),
);

test.each(profiles)(
    "node origins distinguish removal and identical replacement despite matching business IDs: %j",
    async ({ repeated, name }) => {
        const hooks =
            referenceMethod("ChangeRequestStructure", mutate) +
            referenceEvent("REF_RECORD", "onBeforeVersion", "ChangeRequestStructure");
        const fixtures = repeated
            ? `ReferenceFixed: [{ source_id: { name: "Parent" }, related_id: { name: "Child" }, sort_order: 7 }],`
            : "";
        await using project = await referenceProject(
            generatedUpdateSources(true, replacement) + hooks,
            fixtures,
        );
        using h = await createHarness({ cwd: project.cwd, csharp: {} });
        const parent = h.state.getOne("ReferenceRecord", { name: "Parent" });
        const child = h.state.getOne("ReferenceRecord", { name: "Child" });
        const stored = h.state.get("ReferenceFixed", { source_id: parent.id })[0];
        const attributes = repeated && stored ? `action="edit" id="${stored.id}"` : 'action="add"';
        const result =
            await h.applyAML(`<Item type="ReferenceRecord" action="edit" id="${parent.id}">
            <name>${name}</name><Relationships>
                <Item type="ReferenceFixed" ${attributes}><related_id>${child.id}</related_id><sort_order>10</sort_order></Item>
                <Item type="ReferenceFixed" ${attributes}><related_id>${child.id}</related_id><sort_order>10</sort_order></Item>
            </Relationships></Item>`);
        const current = h.state.get("ReferenceFixed", { source_id: result.getID() });

        expect(result.isError()).toBe(false);
        expect(current).toHaveLength(repeated || name === "Remove" ? 1 : 2);
        expect(
            current.every((row) => row.properties.sort_order === (name === "Remove" ? 99 : 10)),
        ).toBe(true);
        expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.Committed);
        expect(h.executions.at(-1)?.mocks).toEqual([]);
    },
    60_000,
);
