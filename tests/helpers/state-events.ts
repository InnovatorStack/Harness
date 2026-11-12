import { referenceEvent, referenceMethod } from "./references.js";

export function stateEvent(name: string, method: string, source: string, required = false): string {
    return (
        referenceMethod(method, source) + referenceEvent("REF_RECORD", name, method, { required })
    );
}

export const lockDelegate = `//MethodTemplateName=CSharpInOut;
ValidateInput(inDom, eventData);
eventData.BaseLockItem(outDom);
var item = outDom.SelectSingleNode("//Result/Item");
if (item == null)
{
    if (inDom.DocumentElement.GetAttribute("doGetItem") != "0" ||
        outDom.SelectSingleNode("//Result")?.InnerText != "Ok.")
    {
        throw new Exception("The native lock returned neither an Item nor its acknowledgement");
    }
    return;
}
var property = outDom.CreateElement("replacement_marker");
property.InnerText = "source";
item.AppendChild(property);
}

private static void ValidateInput(XmlDocument input, Aras.Server.Core.OnLockEventArgs data)
{
    if (input.SelectSingleNode("/Item[@action='lock']") == null || data == null)
    {
        throw new Exception("Wrong native lock context");
    }
`;

export const unlockDelegate = `//MethodTemplateName=CSharpInOut;
eventData.BaseUnlockItem(outDom);`;

export const afterLock = `
if (this.getProperty("name") != "Parent" || this.getProperty("locked_by_id").Length != 32)
{
    throw new Exception("After-lock must receive the stored response");
}
this.setProperty("response_marker", "after");
return this;`;
