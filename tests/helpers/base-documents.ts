import { referenceEvent, referenceMethod } from "./references.js";

export function baseDocumentMethods(verb: "Get" | "Add", template: string): string {
    const type = verb === "Get" ? "ReferenceRecord" : "ReferenceHolder";
    const owner = verb === "Get" ? "REF_RECORD" : "REF_HOLDER";
    const savedName = verb === "Get" ? "Parent" : "Saved captured value";
    const body = `
var selected = inDom.DocumentElement;
var name = selected.SelectSingleNode("name");
var text = name.FirstChild;
var originalComment = inDom.CreateComment("Original retained comment");
selected.AppendChild(originalComment);
eventData.Base${verb}Item(outDom);
if (Object.ReferenceEquals(selected, inDom.DocumentElement) || selected.ParentNode != null)
{
    throw new Exception("Base delegation did not detach the old document root");
}
if (!Object.ReferenceEquals(name, selected.SelectSingleNode("name"))
    || !Object.ReferenceEquals(text, name.FirstChild)
    || name.InnerText != "${savedName}"
    || !Object.ReferenceEquals(originalComment.ParentNode, selected))
{
    throw new Exception("The captured request lost its retained views or values");
}
if (inDom.DocumentElement.Name != "AML"
    || inDom.SelectSingleNode("AML/comment()").Value != "Reload marker"
    || inDom.SelectSingleNode("AML/Item/name").InnerText != "Current document value")
{
    throw new Exception("The caller did not receive the current document and its XML");
}`;
    const replacement =
        template === "CSharpInOut"
            ? `// MethodTemplateName = CSharpInOut;\n${body}`
            : `var inDom = this.dom;
var outDom = new System.Xml.XmlDocument();
${body}
var result = this.newItem();
result.loadAML(outDom.OuterXml);
return result;`;
    const reload = `
var selected = this.node;
this.loadAML("<AML><!--Reload marker--><Item type='${type}' action='${verb.toLowerCase()}'><name>Reloaded document</name></Item></AML>");
selected.SelectSingleNode("name").InnerText = "${savedName}";
return this;`;
    const inspect = `
if (this.dom.DocumentElement.Name != "AML"
    || this.dom.SelectSingleNode("AML/comment()").Value != "Reload marker"
    || this.getProperty("name") != "Reloaded document")
{
    throw new Exception("The later hook did not receive the actual reloaded XML");
}
this.setProperty("name", "Current document value");
return this;`;

    return (
        referenceMethod("DelegateDocument", replacement) +
        referenceEvent(owner, `on${verb}`, "DelegateDocument") +
        referenceMethod("ReloadBaseDocument", reload) +
        referenceEvent(owner, `onBefore${verb}`, "ReloadBaseDocument", { order: 10 }) +
        referenceMethod("InspectBaseDocument", inspect) +
        referenceEvent(owner, `onBefore${verb}`, "InspectBaseDocument", { order: 20 })
    );
}
