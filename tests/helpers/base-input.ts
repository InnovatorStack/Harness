export const retainedBaseInputSource = `// MethodTemplateName = CSharpInOut;
var input = inDom.SelectSingleNode("//Item") as XmlElement
    ?? throw new Exception("Missing request Item");
var root = inDom.DocumentElement;
var id = input.GetAttributeNode("id") ?? input.GetAttributeNode("idlist");
var where = input.GetAttributeNode("where");
bool generated = input.HasAttribute("oldId");
var name = input.SelectSingleNode("name") as XmlElement
    ?? throw new Exception("Missing name");
var text = inDom.CreateCDataSection(name.InnerText);
name.RemoveAll();
name.AppendChild(text);
var comment = inDom.CreateComment("Retained by the Method");
input.AppendChild(comment);

eventData.BaseUpdateItem(outDom);

if (!Object.ReferenceEquals(root, inDom.DocumentElement)
    || !Object.ReferenceEquals(input, inDom.SelectSingleNode("//Item"))
    || !Object.ReferenceEquals(name, input.SelectSingleNode("name"))
    || !Object.ReferenceEquals(text, name.FirstChild)
    || !Object.ReferenceEquals(comment.ParentNode, input))
{
    throw new Exception("Base delegation replaced retained input nodes");
}
if (id != null && input.HasAttribute(id.Name)
    && !Object.ReferenceEquals(id, input.GetAttributeNode(id.Name)))
{
    throw new Exception("Base delegation replaced the retained ID attribute");
}
if (where != null && where.OwnerElement != null)
{
    throw new Exception("The retained WHERE attribute was not removed");
}
if (input.GetAttribute("action") != "version" || !input.HasAttribute("oldId"))
{
    throw new Exception("Base changes did not reach the Method's live input");
}
var ids = input.GetAttribute("id");
if (String.IsNullOrEmpty(ids)) { ids = input.GetAttribute("idlist"); }
var resultIds = outDom.SelectNodes("//Result/Item").OfType<XmlElement>()
    .Select(item => item.GetAttribute("id"));
if (String.Join(",", resultIds) != ids)
{
    throw new Exception("The input selectors do not identify the base result");
}
var inn = new Innovator(InnovatorServerASP);
var audit = inn.newItem("ReplacementAudit", "add");
audit.setProperty("phase", generated ? "generated" : "initial");
audit.setProperty("request_xml", inDom.OuterXml);
var saved = audit.apply();
if (saved.isError()) { throw new Exception(saved.getErrorString()); }
`;

export const nestedBaseInputSource = `// MethodTemplateName = CSharpInOut;
var input = inDom.DocumentElement ?? throw new Exception("Missing request");
bool generated = input.HasAttribute("oldId");
var relationship = input.SelectSingleNode("Relationships/Item") as XmlElement
    ?? throw new Exception("Missing relationship");
var id = relationship.GetAttributeNode("id");
string original = relationship.GetAttribute("id");
var value = relationship.SelectSingleNode("sort_order")
    ?? throw new Exception("Missing relationship value");

eventData.BaseUpdateItem(outDom);

if (!Object.ReferenceEquals(relationship, input.SelectSingleNode("Relationships/Item"))
    || !Object.ReferenceEquals(id, relationship.GetAttributeNode("id"))
    || !Object.ReferenceEquals(value, relationship.SelectSingleNode("sort_order")))
{
    throw new Exception("A retained relationship reference was replaced");
}
if (!generated && relationship.GetAttribute("id") == original)
{
    throw new Exception("The copied relationship ID did not reach the retained node");
}
var parent = outDom.SelectSingleNode("//Result/Item") as XmlElement
    ?? throw new Exception("Missing base result");
var inn = new Innovator(InnovatorServerASP);
var query = inn.newItem("ReferenceFixed", "get");
query.setID(relationship.GetAttribute("id"));
var stored = query.apply();
if (stored.isError() || stored.getProperty("source_id") != parent.GetAttribute("id")
    || stored.getProperty("sort_order") != "20")
{
    throw new Exception("The retained relationship no longer identifies the saved copy");
}
`;

export const itemViewBaseInputSource = `
var view = this.getItemsByXPath("//Relationships/Item").getItemByIndex(0);
var element = view.node;
var attribute = element.GetAttributeNode("id");
var output = new System.Xml.XmlDocument();
eventData.BaseUpdateItem(output);
if (!Object.ReferenceEquals(element, view.node)
    || !Object.ReferenceEquals(attribute, element.GetAttributeNode("id")))
{
    throw new Exception("The retained XPath Item view was replaced");
}
var result = this.getInnovator().newItem();
result.loadAML(output.OuterXml);
var query = this.newItem("ReferenceFixed", "get");
query.setID(view.getID());
var stored = query.apply();
if (stored.isError() || stored.getProperty("source_id") != result.getID()
    || stored.getProperty("sort_order") != "20")
{
    throw new Exception("The retained XPath Item view did not observe its new identity");
}
return result;`;

export const failedBaseInputSource = `// MethodTemplateName = CSharpInOut;
var input = inDom.DocumentElement ?? throw new Exception("Missing request");
eventData.BaseUpdateItem(outDom);
var fault = outDom.SelectSingleNode("//*[local-name()='Fault']/faultstring");
if (fault != null)
{
    if (input.GetAttribute("action") != "version")
    {
        throw new Exception("Failure discarded the request's version action");
    }
    throw new Exception("Verified live version input after failed base");
}
`;

export const wrappedBaseInputSource = `
var input = this.node;
var document = this.dom;
var container = document.DocumentElement;
var name = input.SelectSingleNode("name");
var output = new System.Xml.XmlDocument();
eventData.BaseUpdateItem(output);
if (!Object.ReferenceEquals(input, this.node)
    || !Object.ReferenceEquals(container, document.DocumentElement)
    || !Object.ReferenceEquals(name, input.SelectSingleNode("name")))
{
    throw new Exception("The ordinary Item wrapper lost its retained input views");
}
var result = this.getInnovator().newItem();
result.loadAML(output.OuterXml);
if (this.getID() != result.getID() || this.getAction() != "version"
    || String.IsNullOrEmpty(this.getAttribute("oldId")))
{
    throw new Exception("Item helpers did not observe native base request changes");
}
return result;`;

export const changedPropertiesInputSource = `// MethodTemplateName = CSharpInOut;
var input = inDom.DocumentElement ?? throw new Exception("Missing request");
var name = input.SelectSingleNode("name") ?? throw new Exception("Missing name");
var text = name.FirstChild;
var count = input.SelectSingleNode("count");
var comment = inDom.CreateComment("Keep unmodeled XML");
input.AppendChild(comment);
eventData.BaseUpdateItem(outDom);
if (!Object.ReferenceEquals(name, input.SelectSingleNode("name"))
    || (text != null && !Object.ReferenceEquals(text, name.FirstChild))
    || name.InnerText != "Hook value")
{
    throw new Exception("Native property changes replaced the retained property or text node");
}
if (name is XmlElement property && property.GetAttribute("is_null") == "1")
{
    throw new Exception("The changed name retained its null flag");
}
if ((count != null && count.ParentNode != null) || input.SelectSingleNode("count") != null)
{
    throw new Exception("A property removed during versioning survived in the input DOM");
}
if (input.SelectSingleNode("new_version")?.InnerText != "1"
    || !Object.ReferenceEquals(comment.ParentNode, input))
{
    throw new Exception("Native property insertion discarded unrelated XML");
}
`;

export const queryBaseInputSource = `// MethodTemplateName = CSharpInOut;
var input = inDom.DocumentElement ?? throw new Exception("Missing input");
var names = input.SelectNodes("name");
var nested = input.SelectSingleNode("fixed_ref/Item");
var nestedName = nested?.SelectSingleNode("name");
eventData.BaseGetItem(outDom);
if (nested != null)
{
    if (names.Count != 2 || names[0].InnerText != "Other parent"
        || names[1].InnerText != "Changed criteria"
        || !Object.ReferenceEquals(names[0], input.SelectNodes("name")[0])
        || !Object.ReferenceEquals(names[1], input.SelectNodes("name")[1]))
    {
        throw new Exception("Implicit query groups lost their original property bindings");
    }
    if (!Object.ReferenceEquals(nested, input.SelectSingleNode("fixed_ref/Item"))
        || !Object.ReferenceEquals(nestedName, nested.SelectSingleNode("name"))
        || nestedName?.InnerText != "Child")
    {
        throw new Exception("Expanded query Items lost their retained input views");
    }
}
`;

export const queryBeforeGetSource = `
var names = this.node.SelectNodes("name");
if (names.Count == 2) { names[1].InnerText = "Changed criteria"; }
var nested = this.node.SelectSingleNode("fixed_ref/Item/name");
if (nested != null) { nested.InnerText = "Child"; }
return this;`;
