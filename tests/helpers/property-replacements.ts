export const replacePropertyInput = `
var replacement = this.newItem("ReferenceRecord", "get");
replacement.setProperty("name", this.getProperty("name", "Other parent"));
this.setPropertyItem("fixed_ref", replacement);
return this;`;

const inspectReplacement = `
if (initial)
{
    var currentProperty = input.SelectSingleNode("fixed_ref");
    var current = currentProperty?.SelectSingleNode("Item");
    if (!Object.ReferenceEquals(property, currentProperty)
        || Object.ReferenceEquals(previous, current) || previous.ParentNode != null
        || !Object.ReferenceEquals(previousName, previous.SelectSingleNode("name"))
        || previousName.InnerText != "Child" || property.Attributes["keyed_name"]?.Value != "Keep"
        || current?.SelectSingleNode("name")?.InnerText != expected)
    {
        throw new Exception("Property replacement lost native XML ownership");
    }
    input.SetAttribute("replacement_verified", "1");
}`;

export function propertyReplacement(template: "CSharp" | "CSharpInOut"): string {
    const capture = `
var property = input.SelectSingleNode("fixed_ref") ?? throw new Exception("Missing property");
var previous = property.SelectSingleNode("Item") ?? throw new Exception("Missing child");
var previousName = previous.SelectSingleNode("name") ?? throw new Exception("Missing child name");
string expected = input.SelectSingleNode("name")?.InnerText ?? "Other parent";
bool initial = !input.HasAttribute("oldId");`;

    if (template === "CSharpInOut") {
        return `// MethodTemplateName = CSharpInOut;
var input = inDom.DocumentElement ?? throw new Exception("Missing input");
${capture}
eventData.BaseUpdateItem(outDom);
${inspectReplacement}`;
    }

    return `
var input = this.node;
var retained = this.getPropertyItem("fixed_ref");
${capture}
var output = new System.Xml.XmlDocument();
eventData.BaseUpdateItem(output);
${inspectReplacement}
if (initial && !Object.ReferenceEquals(retained.node, previous))
{
    throw new Exception("A retained Item view was rebound to a replacement");
}
var response = this.newItem();
response.loadAML(output.OuterXml);
return response;`;
}

export const replaceNestedPropertyInput = `
var parent = this.getPropertyItem("fixed_ref");
if (parent?.getPropertyItem("float_ref") != null)
{
    var replacement = this.newItem("ReferenceRecord", "get");
    replacement.setProperty("name", "Other parent");
    parent.setPropertyItem("float_ref", replacement);
}
return this;`;

export function nestedPropertyReplacement(template: "CSharp" | "CSharpInOut"): string {
    const verify = `
if (property != null)
{
    var current = input.SelectSingleNode("fixed_ref/Item/float_ref");
    var child = current?.SelectSingleNode("Item");
    if (!Object.ReferenceEquals(property, current)
        || Object.ReferenceEquals(previous, child) || previous.ParentNode != null
        || previous.SelectSingleNode("name")?.InnerText != "Child"
        || child?.SelectSingleNode("name")?.InnerText != "Other parent")
    {
        throw new Exception("A nested property replacement lost native XML ownership");
    }
}`;

    if (template === "CSharpInOut") {
        return `// MethodTemplateName = CSharpInOut;
var input = inDom.DocumentElement ?? throw new Exception("Missing input");
var property = input.SelectSingleNode("fixed_ref/Item/float_ref");
var previous = property?.SelectSingleNode("Item");
eventData.BaseGetItem(outDom);
${verify}`;
    }

    return `
var input = this.node;
var property = input.SelectSingleNode("fixed_ref/Item/float_ref");
var previous = property?.SelectSingleNode("Item");
var output = new System.Xml.XmlDocument();
eventData.BaseGetItem(output);
${verify}
var result = this.newItem();
result.loadAML(output.OuterXml);
return result;`;
}
