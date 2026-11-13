using System.Runtime.CompilerServices;
using System.Xml;

namespace InnovatorHarness.Managed;

// Selected nodes can outlive a document reload. Only the document owns its response projection.
internal static class ItemDocuments
{
    private sealed class Projection
    {
        internal long Revision { get; set; } = -1;
        internal ItemPayload? Payload { get; set; }
    }

    private static readonly ConditionalWeakTable<XmlDocument, Projection> documents = new();
    private static readonly ConditionalWeakTable<ItemPayload, XmlDocument> restored = new();

    internal static XmlDocument Create(ItemPayload payload)
    {
        if (restored.TryGetValue(payload, out XmlDocument? document))
        {
            return document;
        }

        if (payload.Items.FirstOrDefault()?.Element is { } element)
        {
            return XmlTraversal.Owner(element);
        }

        if (payload.Items.Count == 1 && payload.Error is null && payload.Result is null
            && payload.Messages is not { Count: > 0 })
        {
            return XmlTraversal.Owner(ItemXml.View(payload.Items[0]));
        }

        var created = XmlTraversal.Document();
        ResponseXml.Write(created, payload);

        return created;
    }

    internal static void Remember(ItemPayload payload, XmlDocument document)
    {
        restored.Add(payload, document);
    }

    internal static ItemPayload Read(XmlDocument document)
    {
        Projection projection = documents.GetValue(document, _ => new Projection());
        long revision = DomChanges.Version(document);

        if (projection.Payload is null || projection.Revision != revision)
        {
            ItemPayload payload = ResponseXml.Read(document);
            ItemXml.Synchronize(payload);
            projection.Payload = payload;
            projection.Revision = revision;
        }

        return projection.Payload;
    }
}
