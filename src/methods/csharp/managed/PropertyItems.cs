using System.Xml;

namespace InnovatorHarness.Managed;

internal static class PropertyItems
{
    // A property keeps its wrapper and attributes; the supplied Item becomes an imported copy.
    public static XmlElement Replace(XmlElement property, XmlElement source)
    {
        XmlTraversal.Validate(source);

        if (XmlTraversal.Owner(property).ImportNode(source, deep: true) is not XmlElement copy)
        {
            throw new InvalidOperationException("A property Item copy must remain an element.");
        }

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
}
