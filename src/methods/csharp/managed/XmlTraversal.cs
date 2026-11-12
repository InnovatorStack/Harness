using System.Xml;

namespace InnovatorHarness.Managed;

internal static class XmlTraversal
{
    public static XmlDocument Document()
    {
        return new XmlDocument { PreserveWhitespace = true, XmlResolver = null };
    }

    public static XmlDocument Owner(XmlNode node)
    {
        return node.OwnerDocument
            ?? throw new InvalidOperationException("An XML node must have an owning document.");
    }

    public static XmlElement Root(XmlDocument document)
    {
        return document.DocumentElement
            ?? throw new InvalidOperationException("An XML document must have a root element.");
    }

    public static XmlDocument Load(string xml)
    {
        if (xml.Length > WorkLimits.DataBytesMax)
        {
            throw new NotSupportedException("XML exceeds the managed text limit.");
        }

        var settings = new XmlReaderSettings
        {
            DtdProcessing = DtdProcessing.Prohibit,
            XmlResolver = null,
            MaxCharactersInDocument = WorkLimits.DataBytesMax
        };

        using (var text = new StringReader(xml))
        {
            using XmlReader reader = XmlReader.Create(text, settings);
            int nodes = 0;

            while (reader.Read())
            {
                nodes += 1;

                if (nodes > WorkLimits.NodesMax || reader.Depth > WorkLimits.DepthMax)
                {
                    throw new NotSupportedException("XML exceeds its node or nesting limit.");
                }
            }
        }

        using var input = new StringReader(xml);
        using XmlReader validated = XmlReader.Create(input, settings);
        var document = Document();
        document.Load(validated);

        return document;
    }

    public static IEnumerable<XmlElement> Elements(XmlElement root)
    {
        var pending = new Stack<(XmlElement Element, int Depth)>();
        pending.Push((root, 0));
        int nodes = 0;
        long bytes = 0;

        while (pending.Count > 0)
        {
            var (element, depth) = pending.Pop();
            nodes += 1;
            bytes += element.Name.Length * 3L;

            foreach (XmlAttribute attribute in element.Attributes)
            {
                bytes += (attribute.Name.Length + attribute.Value.Length) * 3L;
            }

            foreach (XmlNode child in element.ChildNodes)
            {
                if (child is XmlElement nested)
                {
                    pending.Push((nested, depth + 1));
                }
                else
                {
                    nodes += 1;
                    bytes += (child.Value?.Length ?? 0) * 3L;
                }
            }

            if (nodes > WorkLimits.NodesMax || depth > WorkLimits.DepthMax
                || bytes > WorkLimits.DataBytesMax || pending.Count > WorkLimits.NodesMax)
            {
                throw new NotSupportedException("XML exceeds its managed traversal budget.");
            }

            yield return element;
        }
    }

    public static void Validate(XmlElement root)
    {
        foreach (XmlElement element in Elements(root))
        {
            // Complete the bounded walk before calling recursive native DOM operations.
            _ = element;
        }
    }

    public static IEnumerable<(XmlElement Source, XmlElement Copy)> Pairs(
        XmlElement source, XmlElement copy)
    {
        using var sources = Elements(source).GetEnumerator();
        using var copies = Elements(copy).GetEnumerator();

        while (sources.MoveNext())
        {
            if (!copies.MoveNext())
            {
                throw new InvalidOperationException("An XML copy must preserve the source shape.");
            }

            yield return (sources.Current, copies.Current);
        }

        if (copies.MoveNext())
        {
            throw new InvalidOperationException("An XML copy has more nodes than its source.");
        }
    }
}
