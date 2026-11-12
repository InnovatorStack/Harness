using System.Xml;

namespace InnovatorHarness.Managed;

internal static class ResponseXml
{
    public static ItemPayload Read(XmlDocument document)
    {
        XmlElement root = XmlTraversal.Root(document);
        XmlTraversal.Validate(root);

        if (root.Name is "Item" or "Result" or "AML")
        {
            return ReadResult(root);
        }

        if (root.LocalName != "Envelope"
            || root.NamespaceURI != "http://schemas.xmlsoap.org/soap/envelope/")
        {
            throw new NotSupportedException("Expected a native AML response or SOAP envelope.");
        }

        XmlElement body = root.ChildNodes.OfType<XmlElement>()
            .Single(element => element.LocalName == "Body"
                && element.NamespaceURI == root.NamespaceURI);
        XmlElement? fault = body.ChildNodes.OfType<XmlElement>()
            .SingleOrDefault(element => element.LocalName == "Fault");

        if (fault is not null)
        {
            return new ItemPayload
            {
                Error = new(
                fault.SelectSingleNode("faultcode")?.InnerText ?? "ApplicationError",
                fault.SelectSingleNode("faultstring")?.InnerText
                    ?? "Native Method returned a fault.")
            };
        }

        XmlElement result = body.ChildNodes.OfType<XmlElement>()
            .Single(element => element.Name == "Result");
        var payload = ReadResult(result);
        XmlNodeList messages = body.SelectNodes("Message/event")
            ?? throw new InvalidOperationException("Response messages must be readable.");

        if (messages.Count > 0)
        {
            payload.Messages = messages.OfType<XmlElement>()
                .Select(element => new ItemMessage(
                    element.GetAttribute("name"), element.GetAttribute("value")))
                .ToList();
        }

        return payload;
    }

    public static void Write(XmlDocument document, ItemPayload payload)
    {
        document.RemoveAll();
        XmlElement result = PayloadXml.CreateResult(document, payload, wrapEnvelope: true);

        if (payload.Error is { } error)
        {
            XmlElement fault = document.CreateElement(
                "SOAP-ENV", "Fault", "http://schemas.xmlsoap.org/soap/envelope/");
            XmlElement code = document.CreateElement("faultcode");
            XmlElement message = document.CreateElement("faultstring");
            code.InnerText = error.Code;
            message.InnerText = error.Message;
            fault.AppendChild(code);
            fault.AppendChild(message);
            result.ParentNode?.ReplaceChild(fault, result);

            return;
        }

        if (payload.Result is not null)
        {
            result.InnerText = payload.Result;
        }

        foreach (ItemData item in payload.Items)
        {
            ItemXml.Attach(result, item);
        }
    }

    private static ItemPayload ReadResult(XmlElement result)
    {
        if (result.Name == "Item")
        {
            return new ItemPayload { Items = new() { ItemXml.Bind(result) } };
        }

        var items = new List<ItemData>();

        foreach (XmlElement element in result.ChildNodes.OfType<XmlElement>())
        {
            if (element.Name != "Item")
            {
                throw new NotSupportedException("A native Result must contain Item elements.");
            }

            items.Add(ItemXml.Bind(element));
        }

        if (items.Count == 0 && result.Name == "Result")
        {
            return new ItemPayload { Result = result.InnerText };
        }

        return new ItemPayload { Items = items };
    }
}
