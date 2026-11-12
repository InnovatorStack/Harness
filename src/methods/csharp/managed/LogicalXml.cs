using System.Text.Json;
using System.Xml;

namespace InnovatorHarness.Managed;

internal static class LogicalXml
{
    public static bool IsGroup(string name) => name is "and" or "or" or "not";

    public static LogicalData Read(XmlElement root, List<ItemData> children)
    {
        var result = new LogicalData { Operator = root.Name, Terms = new() };
        var pending = new Stack<(XmlElement Element, LogicalData Group)>();
        pending.Push((root, result));

        while (pending.Count > 0)
        {
            var (element, group) = pending.Pop();

            if (element.HasAttributes || element.ChildNodes.OfType<XmlText>()
                .Any(text => !string.IsNullOrWhiteSpace(text.Value)))
            {
                throw new NotSupportedException("Logical groups require property criteria.");
            }

            List<LogicalData> terms = group.Terms
                ?? throw new InvalidOperationException("A logical group must retain its terms.");

            foreach (XmlElement property in element.ChildNodes.OfType<XmlElement>())
            {
                if (IsGroup(property.Name))
                {
                    var nested = new LogicalData { Operator = property.Name, Terms = new() };
                    terms.Add(nested);
                    pending.Push((property, nested));
                }
                else
                {
                    terms.Add(ReadCondition(property, children));
                }
            }
        }

        return result;
    }

    public static LogicalData ReadCondition(XmlElement property, List<ItemData> children)
    {
        var condition = new LogicalData
        {
            Name = property.Name,
            Attributes = property.Attributes.Cast<XmlAttribute>()
                .ToDictionary(attribute => attribute.Name, attribute => attribute.Value)
        };
        var nested = property.ChildNodes.OfType<XmlElement>().ToList();

        if (nested.Count > 0)
        {
            if (nested.Count != 1 || nested[0].Name != "Item")
            {
                throw new NotSupportedException("A property must contain one nested Item.");
            }

            condition.Item = ItemXml.Bind(nested[0]);
            children.Add(condition.Item);
        }
        else
        {
            string? value = property.InnerText;

            if (property.GetAttribute("is_null") == "1")
            {
                value = null;
            }

            condition.Value = JsonSerializer.SerializeToElement(value);
        }

        return condition;
    }

    public static IEnumerable<ItemXml.Attachment> Write(ItemData item, XmlElement element)
    {
        var pending = new Stack<(LogicalData Data, XmlElement Parent, int Depth)>();

        foreach (LogicalData group in (item.Logical ?? new()).AsEnumerable().Reverse())
        {
            pending.Push((group, element, 0));
        }

        int visited = 0;

        while (pending.Count > 0)
        {
            var (data, parent, depth) = pending.Pop();
            visited += 1;

            if (visited > WorkLimits.NodesMax || depth > WorkLimits.DepthMax)
            {
                throw new NotSupportedException("Logical AML exceeds its traversal budget.");
            }

            if (data.Operator is not null)
            {
                XmlElement container = GroupElement(data, parent, depth);

                List<LogicalData> terms = data.Terms
                    ?? throw new InvalidOperationException("A logical group needs terms.");

                for (int index = terms.Count - 1; index >= 0; index -= 1)
                {
                    pending.Push((terms[index], container, depth + 1));
                }

            }
            else
            {
                XmlElement property = WriteCondition(data, parent);

                if (data.Item is not null)
                {
                    yield return new(property, data.Item);
                }
            }
        }
    }

    private static XmlElement GroupElement(LogicalData data, XmlElement parent, int depth)
    {
        if (!IsGroup(data.Operator ?? "")
            || (data.Implicit && (data.Operator != "and" || depth != 0)))
        {
            throw new NotSupportedException("Invalid logical AML operator or implicit group.");
        }

        if (data.Implicit)
        {
            return parent;
        }

        XmlElement group = XmlTraversal.Owner(parent).CreateElement(data.Operator
            ?? throw new InvalidOperationException("A logical group needs its operator."));
        parent.AppendChild(group);

        return group;
    }

    private static XmlElement WriteCondition(LogicalData data, XmlElement parent)
    {
        XmlElement property = XmlTraversal.Owner(parent).CreateElement(data.Name
            ?? throw new InvalidOperationException("A criterion needs a property name."));

        foreach (var attribute in data.Attributes)
        {
            property.SetAttribute(attribute.Key, attribute.Value);
        }

        if (data.Item is null)
        {
            if (data.Value.ValueKind == JsonValueKind.Null)
            {
                property.SetAttribute("is_null", "1");
            }
            else
            {
                string text = data.Value.GetRawText();

                if (data.Value.ValueKind == JsonValueKind.String)
                {
                    text = data.Value.GetString() ?? "";
                }

                property.InnerText = text;
            }
        }

        parent.AppendChild(property);

        return property;
    }
}
