export type EventResponse = "item" | "result" | "empty";

const responses: Readonly<Record<EventResponse, string>> = {
    item: `var response = this.newItem(this.getType(), this.getAction());
response.setID(this.getID());
response.setProperty("name", "Response only");
return response;`,
    result: 'return this.getInnovator().newResult("Response only");',
    empty: "return null;",
};

export function eventResultSource(response: EventResponse, name = "From input"): string {
    return `this.setProperty("name", "${name}");
${responses[response]}`;
}

export function inOutEventResultSource(response: EventResponse): string {
    const outputs: Readonly<Record<EventResponse, string>> = {
        item: '<Item type="ReferenceRecord"><name>Response only</name></Item>',
        result: "<Result>Response only</Result>",
        empty: "<Result />",
    };
    const xml = outputs[response].replaceAll('"', '\\"');

    return `// MethodTemplateName = CSharpInOut;
var input = inDom.DocumentElement ?? throw new Exception("Missing input");
var name = input.SelectSingleNode("name") ?? throw new Exception("Missing name");
name.InnerText = "From input";
outDom.LoadXml("${xml}");`;
}

export const validateEventInput = `
if (this.getProperty("name") != "From input")
{
    throw new Exception("The separate event response replaced pending input");
}
this.setProperty("name", "Validated input");
return this.getInnovator().newResult("Another response");`;
