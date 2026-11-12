using System.Xml;

namespace InnovatorHarness.Managed;

internal static class PayloadXml
{
    public static XmlElement CreateResult(
        XmlDocument document, ItemPayload payload, bool wrapEnvelope = false)
    {
        XmlElement result = document.CreateElement("Result");

        if (!wrapEnvelope && payload.Messages is not { Count: > 0 })
        {
            document.AppendChild(result);

            return result;
        }

        const string soapNamespace = "http://schemas.xmlsoap.org/soap/envelope/";
        XmlElement envelope = document.CreateElement("SOAP-ENV", "Envelope", soapNamespace);
        XmlElement body = document.CreateElement("SOAP-ENV", "Body", soapNamespace);
        document.AppendChild(envelope);
        envelope.AppendChild(body);
        body.AppendChild(result);
        XmlElement message = document.CreateElement("Message");
        body.AppendChild(message);

        foreach (ItemMessage entry in payload.Messages ?? new())
        {
            XmlElement element = document.CreateElement("event");
            element.SetAttribute("name", entry.Name);
            element.SetAttribute("value", entry.Value);
            message.AppendChild(element);
        }

        return result;
    }

    public static void Synchronize(ItemPayload payload)
    {
        XmlDocument? document = payload.Items.FirstOrDefault()?.Element?.OwnerDocument;

        if (document is null || document.DocumentElement?.LocalName != "Envelope")
        {
            return;
        }

        XmlNodeList nodes = document.SelectNodes("/*/*/Message/event")
            ?? throw new InvalidOperationException("Response metadata must be readable.");
        payload.Messages = new();

        foreach (XmlElement entry in nodes.OfType<XmlElement>())
        {
            payload.Messages.Add(new(entry.GetAttribute("name"), entry.GetAttribute("value")));
        }
    }
}
