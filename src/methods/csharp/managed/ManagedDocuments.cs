using System.Xml;

namespace InnovatorHarness.Managed;

internal static class ManagedDocuments
{
    internal static XmlDocument Read(DocumentInput input)
    {
        XmlDocument document = XmlTraversal.Load(input.Xml);

        if (input.Change is { } change)
        {
            RequestXml.Synchronize(RequestXml.Input(document), change);
        }

        return document;
    }

    internal static ItemPayload Restore(ItemPayload expected, DocumentInput input)
    {
        XmlDocument document = Read(input);
        ItemPayload payload = ResponseXml.Read(document);
        ItemXml.Synchronize(payload);
        using var originals = RequestOrigins.Nodes(expected).GetEnumerator();

        foreach (ItemData item in RequestOrigins.Nodes(payload))
        {
            if (!originals.MoveNext())
            {
                throw new InvalidOperationException("Reloaded document has extra Items.");
            }

            // Preserve typed JSON values when their XML text still matches.
            item.Properties = new(originals.Current.Properties);
            item.SynchronizedRevision = null;
        }

        if (originals.MoveNext())
        {
            throw new InvalidOperationException("Reloaded document is missing Items.");
        }

        ItemXml.Synchronize(payload);
        ItemDocuments.Remember(payload, document);

        return payload;
    }
}
