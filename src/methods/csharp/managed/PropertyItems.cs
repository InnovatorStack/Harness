using System.Xml;

namespace InnovatorHarness.Managed;

internal static class PropertyItems
{
    // A property keeps its wrapper and attributes; the supplied Item becomes an imported copy.
    public static XmlElement Replace(XmlElement property, XmlElement source)
    {
        XmlElement copy = Copy(property, source);
        var previous = property.ChildNodes.OfType<XmlElement>()
            .FirstOrDefault(child => child.Name == "Item");

        if (previous is not null)
        {
            property.ReplaceChild(copy, previous);
        }
        else
        {
            property.InnerText = "";
            property.AppendChild(copy);
        }

        return copy;
    }

    public static XmlElement Append(XmlElement parent, XmlElement source)
    {
        XmlElement copy = Copy(parent, source);
        parent.AppendChild(copy);

        return copy;
    }

    private static XmlElement Copy(XmlElement parent, XmlElement source)
    {
        XmlTraversal.Validate(source);

        if (XmlTraversal.Owner(parent).ImportNode(source, deep: true) is XmlElement copy)
        {
            return copy;
        }

        throw new InvalidOperationException("An imported Item must remain an element.");
    }
}
