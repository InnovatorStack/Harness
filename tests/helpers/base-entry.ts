import { referenceEvent, referenceMethod } from "./references.js";

export function baseEntryMethods(verb: "Get" | "Update", template: string): string {
    const expected = verb === "Get" ? "Changed current document" : "Current document";
    const before =
        verb === "Get"
            ? `if (this.getType() != "ReferenceRecord"
    || this.getProperty("name") != "Current document")
{
    throw new Exception("BeforeGet did not receive the replacement document");
}
this.setProperty("name", "Changed current document");
return this;`
            : `if (this.getType() != "ReferenceHolder"
    || this.getProperty("name") != "Captured value")
{
    throw new Exception("BeforeUpdate did not receive the captured request's record copy");
}
this.setProperty("name", "Saved value");
return this;`;
    const body = `
var selected = inDom.DocumentElement;
var name = selected.SelectSingleNode("name");
name.InnerText = "Captured value";
inDom.LoadXml("<AML><!--Entry marker--><Item type='ReferenceRecord' action='add'><name>Current document</name></Item></AML>");
var root = inDom.DocumentElement;
var current = root.SelectSingleNode("Item");
var currentName = current.SelectSingleNode("name");
var text = currentName.FirstChild;
eventData.Base${verb}Item(outDom);
if (selected.ParentNode != null || !Object.ReferenceEquals(name, selected.SelectSingleNode("name"))
    || name.InnerText != "Captured value")
{
    throw new Exception("Base delegation lost its captured input");
}
if (!Object.ReferenceEquals(root, inDom.DocumentElement)
    || !Object.ReferenceEquals(current, root.SelectSingleNode("Item"))
    || !Object.ReferenceEquals(currentName, current.SelectSingleNode("name"))
    || !Object.ReferenceEquals(text, currentName.FirstChild)
    || currentName.InnerText != "${expected}"
    || inDom.SelectSingleNode("AML/comment()").Value != "Entry marker")
{
    throw new Exception("Base delegation replaced retained current-document views");
}`;
    const source =
        template === "CSharpInOut"
            ? `// MethodTemplateName = CSharpInOut;\n${body}`
            : `var inDom = this.dom;
var outDom = new System.Xml.XmlDocument();
${body}
var result = this.newItem();
result.loadAML(outDom.OuterXml);
return result;`;

    return (
        referenceMethod("ReloadBeforeEntry", source) +
        referenceEvent("REF_HOLDER", `on${verb}`, "ReloadBeforeEntry") +
        referenceMethod("InspectEntry", before) +
        referenceEvent("REF_HOLDER", `onBefore${verb}`, "InspectEntry")
    );
}
