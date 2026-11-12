import { referenceEvent, referenceMethod } from "./references.js";

const schema = `<Item type="ItemType" action="add" id="REPLACEMENT_AUDIT">
    <name>ReplacementAudit</name><Relationships>
        <Item type="Property" action="add"><name>phase</name><data_type>string</data_type></Item>
        <Item type="Property" action="add"><name>request_xml</name><data_type>string</data_type></Item>
    </Relationships>
</Item>`;

export const updateDelegate = `// MethodTemplateName = CSharpInOut;
var input = inDom.DocumentElement ?? throw new Exception("Missing update context");
bool generated = !String.IsNullOrEmpty(input.GetAttribute("oldId"));
string name = input.SelectSingleNode("name")?.InnerText ?? "";
var innovator = new Innovator(InnovatorServerASP);
var audit = innovator.newItem("ReplacementAudit", "add");
audit.setProperty("phase", generated ? "generated" : "initial");
audit.setProperty("request_xml", inDom.OuterXml);
var captured = audit.apply();
if (captured.isError()) { throw new Exception(captured.getErrorString()); }

if (generated && name == "Skip generated update")
{
    outDom.LoadXml("<Result>Replaced generated update</Result>");
    return;
}
if (generated && name == "Change generated input")
{
    input.SelectSingleNode("name").InnerText = "Saved by replacement";
}
if (generated && name == "Redirect selector")
{
    input.SetAttribute("id", input.GetAttribute("oldId"));
    input.RemoveAttribute("idlist");
}
eventData.BaseUpdateItem(outDom);
if (generated && name == "Reject after base")
{
    throw new Exception("Rejected after generated base update");
}

foreach (XmlElement item in outDom.SelectNodes("//Result/Item"))
{
    var marker = outDom.CreateElement(generated ? "generated_response" : "initial_response");
    marker.InnerText = "source";
    item.AppendChild(marker);
}
`;

export function generatedUpdateSources(
    required = false,
    code = updateDelegate,
    typeId = "REF_RECORD",
): string {
    return (
        schema +
        referenceMethod("ReplaceUpdate", code) +
        referenceEvent(typeId, "onUpdate", "ReplaceUpdate", { required })
    );
}
