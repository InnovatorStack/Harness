using System.Xml;

namespace InnovatorHarness.Managed;

/// <summary>Apply native request changes without replacing retained input DOM nodes.</summary>
internal static class RequestXml
{
    internal sealed record Frame(
        XmlElement Target, XmlElement Before, XmlElement After, int Depth,
        RequestAlignment? Alignment);
    private readonly record struct ChildKey(string Name, int Occurrence);

    public static void Synchronize(XmlDocument document, RequestChange change)
    {
        XmlElement target = Input(document);
        XmlElement before = ItemXml.View(change.Before);
        XmlElement after = ItemXml.View(change.After);
        XmlTraversal.Validate(target);
        XmlTraversal.Validate(before);
        XmlTraversal.Validate(after);
        var pending = new Stack<Frame>();
        pending.Push(new(target, before, after, 0, change.Alignment));
        int visited = 0;

        while (pending.Count > 0)
        {
            Frame frame = pending.Pop();
            visited += 1;

            if (visited > WorkLimits.NodesMax || frame.Depth > WorkLimits.DepthMax
                || pending.Count > WorkLimits.NodesMax)
            {
                throw new NotSupportedException("Request synchronization exceeds its budget.");
            }

            if (frame.Target.Name != frame.Before.Name || frame.Before.Name != frame.After.Name)
            {
                throw new InvalidOperationException("A native request must retain its root shape.");
            }

            Attributes(frame);
            Children(frame, pending);
        }

        XmlTraversal.Validate(target);
    }

    public static XmlElement Input(XmlDocument document)
    {
        ItemPayload request = ResponseXml.Read(document);

        if (request.Items.Count != 1 || request.Error is not null || request.Result is not null)
        {
            throw new InvalidOperationException("A native base call requires one input Item.");
        }

        return ItemXml.View(request.Items[0]);
    }

    private static void Attributes(Frame frame)
    {
        var before = AttributeMap(frame.Before);
        var after = AttributeMap(frame.After);
        var targets = AttributeMap(frame.Target);

        foreach (var (name, _) in before)
        {
            if (!after.ContainsKey(name) && targets.TryGetValue(name, out XmlAttribute? target))
            {
                frame.Target.Attributes.Remove(target);
            }
        }

        foreach (var (name, attribute) in after)
        {
            if (before.TryGetValue(name, out XmlAttribute? previous)
                && previous.Value == attribute.Value)
            {
                continue;
            }

            if (targets.TryGetValue(name, out XmlAttribute? target))
            {
                target.Value = attribute.Value;
            }
            else
            {
                XmlNode copied = XmlTraversal.Owner(frame.Target).ImportNode(attribute, true);
                frame.Target.Attributes.SetNamedItem(copied);
            }
        }
    }

    private static Dictionary<string, XmlAttribute> AttributeMap(XmlElement element)
    {
        return element.Attributes.OfType<XmlAttribute>()
            .ToDictionary(attribute => attribute.Name, StringComparer.Ordinal);
    }

    private static void Children(Frame frame, Stack<Frame> pending)
    {
        if (frame.Alignment?.ReplaceItem == true)
        {
            ReplacePropertyItem(frame);

            return;
        }

        if (frame.Before.Name == "Relationships" && frame.Alignment?.Relationships is { } order)
        {
            RequestRelationships.Synchronize(frame, pending, order);

            return;
        }

        var before = Elements(frame.Before);
        var after = Elements(frame.After);

        if (before.Count == 0 && after.Count == 0)
        {
            Text(frame);

            return;
        }

        if ((before.Count == 0 || after.Count == 0) && !IsCollection(frame.Before))
        {
            ReplaceContent(frame.Target, frame.After);

            return;
        }

        var targets = Elements(frame.Target);

        foreach (var (key, previous) in before)
        {
            if (!targets.TryGetValue(key, out XmlElement? target))
            {
                throw new InvalidOperationException(
                    "The input request changed during its base call.");
            }

            if (after.TryGetValue(key, out XmlElement? next))
            {
                var alignment = frame.Alignment;

                if (frame.Before.Name == "Item" && key.Name != "Relationships"
                    && key.Occurrence == 0)
                {
                    alignment = frame.Alignment?.Properties?.GetValueOrDefault(key.Name);
                }

                pending.Push(new(target, previous, next, frame.Depth + 1, alignment));
            }
            else
            {
                frame.Target.RemoveChild(target);
            }
        }

        foreach (var (key, next) in after)
        {
            if (!before.ContainsKey(key))
            {
                frame.Target.AppendChild(XmlTraversal.Owner(frame.Target).ImportNode(next, true));
            }
        }
    }

    private static void ReplacePropertyItem(Frame frame)
    {
        var before = frame.Before.ChildNodes.OfType<XmlElement>().ToArray();
        var after = frame.After.ChildNodes.OfType<XmlElement>().ToArray();
        var targets = frame.Target.ChildNodes.OfType<XmlElement>().ToArray();

        if (frame.Depth == 0 || before.Length != 1 || after.Length != 1
            || targets.Length != 1 || before[0].Name != "Item" || after[0].Name != "Item"
            || targets[0].Name != "Item")
        {
            throw new InvalidOperationException(
                "A property Item replacement requires one original and resulting child.");
        }

        PropertyItems.Replace(frame.Target, after[0]);
    }

    private static bool IsCollection(XmlElement element)
    {
        return element.Name == "Relationships" || LogicalXml.IsGroup(element.Name)
            || (element.Name == "Item" && element.HasAttribute("type"));
    }

    private static Dictionary<ChildKey, XmlElement> Elements(XmlElement element)
    {
        var elements = new Dictionary<ChildKey, XmlElement>();
        var counts = new Dictionary<string, int>();

        foreach (XmlElement child in element.ChildNodes.OfType<XmlElement>())
        {
            int occurrence = counts.GetValueOrDefault(child.Name);
            counts[child.Name] = occurrence + 1;
            elements.Add(new(child.Name, occurrence), child);
        }

        return elements;
    }

    private static void Text(Frame frame)
    {
        if (frame.Before.InnerText == frame.After.InnerText)
        {
            return;
        }

        if (frame.Target.ChildNodes.Count == 1
            && frame.Target.FirstChild is XmlCharacterData text)
        {
            text.Value = frame.After.InnerText;
        }
        else
        {
            frame.Target.InnerText = frame.After.InnerText;
        }
    }

    private static void ReplaceContent(XmlElement target, XmlElement source)
    {
        while (target.FirstChild is { } child)
        {
            target.RemoveChild(child);
        }

        foreach (XmlNode child in source.ChildNodes)
        {
            target.AppendChild(XmlTraversal.Owner(target).ImportNode(child, true));
        }
    }
}
