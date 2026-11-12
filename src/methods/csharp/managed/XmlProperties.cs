using System.Xml;

namespace Aras.Server.Core;

public static class XML
{
    public static void SetItemPropertyNullInternal(XmlElement item, string name, bool setNullFlag)
    {
        XmlConvert.VerifyName(name);
        var document = item.OwnerDocument
            ?? throw new InvalidOperationException("An Item element requires its owner document.");
        XmlElement? property = item.ChildNodes.OfType<XmlElement>()
            .FirstOrDefault(element => element.Name == name);

        if (property is null)
        {
            property = document.CreateElement(name);
            item.AppendChild(property);
        }

        property.InnerText = string.Empty;

        if (setNullFlag)
        {
            property.SetAttribute("is_null", "1");
        }
        else
        {
            property.SetAttribute("is_null", "0");
        }
    }
}
