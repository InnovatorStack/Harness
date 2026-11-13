export function originReplacement(template: "CSharp" | "CSharpInOut"): string {
    const start =
        template === "CSharpInOut"
            ? `// MethodTemplateName = CSharpInOut;
var input = inDom.DocumentElement ?? throw new Exception("Missing input");
var output = outDom;`
            : `var input = this.node;
var output = new System.Xml.XmlDocument();`;
    const view =
        template === "CSharp"
            ? `var view = this.getItemsByXPath("//Relationships/Item").getItemByIndex(0);`
            : "";
    const verifyView =
        template === "CSharp"
            ? `if (!Object.ReferenceEquals(view.node, rows[0]) || view.getProperty("sort_order") != "99")
    {
        throw new Exception("The held Item view lost its origin");
    }`
            : "";
    const finish =
        template === "CSharp"
            ? `var result = this.getInnovator().newItem();
result.loadAML(output.OuterXml);
return result;`
            : "";

    return `${start}
bool initial = !input.HasAttribute("oldId");
var container = input.SelectSingleNode("Relationships");
var rows = container.SelectNodes("Item").Cast<System.Xml.XmlElement>().ToArray();
var value = rows[0].SelectSingleNode("sort_order");
var text = value.FirstChild;
var id = rows[0].GetAttributeNode("id");
${view}

eventData.BaseUpdateItem(output);

if (initial)
{
    var current = container.SelectNodes("Item").Cast<System.Xml.XmlElement>().ToArray();
    if (current.Length != 2 || !Object.ReferenceEquals(current[0], rows[1])
        || !Object.ReferenceEquals(current[1], rows[0])
        || !Object.ReferenceEquals(value, rows[0].SelectSingleNode("sort_order"))
        || !Object.ReferenceEquals(text, value.FirstChild) || value.InnerText != "99")
    {
        throw new Exception("Changed repeated or anonymous input lost its XML origin");
    }
    if (id != null && !Object.ReferenceEquals(id, rows[0].GetAttributeNode("id")))
    {
        throw new Exception("The copied ID replaced a held attribute");
    }
    ${verifyView}
}
${finish}`;
}

export const reorderChangedRequests = `
var container = this.node.SelectSingleNode("Relationships");
var rows = container.SelectNodes("Item").Cast<System.Xml.XmlElement>().ToArray();
rows[0].SelectSingleNode("sort_order").InnerText = "99";
container.InsertBefore(rows[1], rows[0]);
return this;`;
