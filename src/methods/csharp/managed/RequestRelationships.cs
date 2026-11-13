using System.Xml;

namespace InnovatorHarness.Managed;

/// <summary>Move retained relationship elements using the base request's copy identities.</summary>
internal static class RequestRelationships
{
    public static void Synchronize(
        RequestXml.Frame frame, Stack<RequestXml.Frame> pending,
        List<RelationshipAlignment> order)
    {
        XmlElement[] before = Elements(frame.Before);
        XmlElement[] after = Elements(frame.After);
        XmlElement[] targets = Elements(frame.Target);

        if (targets.Length != before.Length)
        {
            throw new InvalidOperationException(
                "The relationship request changed during its base call.");
        }

        RelationshipAlignment[] mappings = Validate(order, before.Length, after.Length);

        foreach (RelationshipAlignment position in order)
        {
            if (position.Before is { } index && position.After is null)
            {
                frame.Target.RemoveChild(targets[index]);
            }
        }

        XmlElement? cursor = frame.Target.ChildNodes.OfType<XmlElement>().FirstOrDefault();

        for (int index = 0; index < after.Length; index += 1)
        {
            RelationshipAlignment position = mappings[index];
            XmlElement next;

            if (position.Before is { } previous)
            {
                next = targets[previous];
            }
            else
            {
                next = Import(frame.Target, after[index]);
            }

            if (ReferenceEquals(next, cursor))
            {
                cursor = NextElement(next);
            }
            else
            {
                frame.Target.InsertBefore(next, cursor);
            }

            if (position.Before is { } source)
            {
                pending.Push(new(next, before[source], after[index], frame.Depth + 1,
                    position.Alignment));
            }
        }
    }

    private static RelationshipAlignment[] Validate(
        List<RelationshipAlignment> order, int beforeCount, int afterCount)
    {
        var previous = new HashSet<int>();
        var next = new Dictionary<int, RelationshipAlignment>();

        foreach (RelationshipAlignment position in order)
        {
            if (position.Before is { } before
                && (before < 0 || before >= beforeCount || !previous.Add(before)))
            {
                throw new InvalidOperationException("Invalid original relationship position.");
            }

            if (position.After is { } after
                && (after < 0 || after >= afterCount || !next.TryAdd(after, position)))
            {
                throw new InvalidOperationException("Invalid resulting relationship position.");
            }

            if (position.Before is null && position.After is null)
            {
                throw new InvalidOperationException("A relationship mapping requires a position.");
            }
        }

        if (previous.Count != beforeCount || next.Count != afterCount)
        {
            throw new InvalidOperationException(
                "Relationship mappings must cover the full request.");
        }

        return Enumerable.Range(0, afterCount).Select(index => next[index]).ToArray();
    }

    private static XmlElement[] Elements(XmlElement parent)
    {
        XmlElement[] children = parent.ChildNodes.OfType<XmlElement>().ToArray();

        if (children.Any(child => child.Name != "Item"))
        {
            throw new InvalidOperationException("Relationships must contain Item elements.");
        }

        return children;
    }

    private static XmlElement Import(XmlElement target, XmlElement source)
    {
        return XmlTraversal.Owner(target).ImportNode(source, true) as XmlElement
            ?? throw new InvalidOperationException("A relationship copy must remain an element.");
    }

    private static XmlElement? NextElement(XmlElement element)
    {
        XmlNode? next = element.NextSibling;

        while (next is not null && next is not XmlElement)
        {
            next = next.NextSibling;
        }

        return next as XmlElement;
    }
}
