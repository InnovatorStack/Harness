using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Xml;

namespace InnovatorHarness.Managed;

/// <summary>
/// The managed Item uses a live XML tree. The existing JSON payload is a projection
/// made at the Bun boundary; XPath and Item helpers therefore see the same nodes.
/// </summary>
internal static class ItemXml
{
    private static readonly ConditionalWeakTable<XmlElement, ItemData> bindings = new();

    public static XmlElement View(ItemData item)
    {
        if (item.Element is not null)
        {
            return item.Element;
        }

        var document = XmlTraversal.Document();
        XmlElement element = WriteItem(document, item);
        document.AppendChild(element);

        return element;
    }

    public static void Initialize(ItemPayload payload)
    {
        if ((payload.Items.Count < 2 && payload.Messages is not { Count: > 0 })
            || payload.Items.Any(item => item.Element is not null))
        {
            return;
        }

        var document = XmlTraversal.Document();
        XmlElement root = PayloadXml.CreateResult(document, payload);

        foreach (ItemData item in payload.Items)
        {
            root.AppendChild(WriteItem(document, item));
        }
    }

    public static XmlDocument ViewDocument(ItemPayload payload)
    {
        if (payload.Items.Count > 0)
        {
            XmlElement item = View(payload.Items[0]);
            var owner = XmlTraversal.Owner(item);

            if (owner.DocumentElement == item)
            {
                owner.RemoveChild(item);
                XmlElement result = PayloadXml.CreateResult(owner, payload);
                result.AppendChild(item);
            }

            return owner;
        }

        var document = XmlTraversal.Document();
        ResponseXml.Write(document, payload);

        return document;
    }

    public static ItemData Bind(XmlElement element)
    {
        return bindings.GetValue(element, node => new ItemData { Element = node });
    }

    public static XmlElement Property(ItemData item, string name)
    {
        XmlConvert.VerifyName(name);
        XmlElement parent = View(item);
        XmlElement? property = FindProperty(parent, name);

        if (property is null)
        {
            property = XmlTraversal.Owner(parent).CreateElement(name);
            parent.AppendChild(property);
        }

        return property;
    }

    public static XmlElement? FindProperty(XmlElement item, string name)
    {
        return item.ChildNodes.OfType<XmlElement>().FirstOrDefault(child => child.Name == name);
    }

    public static void Attach(XmlElement parent, ItemData item)
    {
        AttachElement(parent, View(item));
    }

    public static ItemPayload Parse(string xml)
    {
        var document = XmlTraversal.Load(xml);
        XmlElement root = XmlTraversal.Root(document);

        if (root.LocalName == "Envelope")
        {
            return ResponseXml.Read(document);
        }

        if (root.Name == "Item")
        {
            return new ItemPayload { Items = new() { Bind(root) } };
        }

        if (root.Name != "AML" && root.Name != "Result")
        {
            throw new InvalidOperationException("Expected an Item, AML, or Result element.");
        }

        var items = new List<ItemData>();

        foreach (XmlElement element in root.ChildNodes.OfType<XmlElement>())
        {
            if (element.Name != "Item")
            {
                throw new InvalidOperationException("Expected an Item element.");
            }

            items.Add(Bind(element));
        }

        if (items.Count == 0 && root.Name == "Result")
        {
            return new ItemPayload { Result = root.InnerText };
        }

        return new ItemPayload { Items = items };
    }

    public static void Synchronize(ItemPayload payload)
    {
        PayloadXml.Synchronize(payload);

        foreach (ItemData item in payload.Items)
        {
            ReadItem(item);
        }
    }

    public static List<ItemData> SelectItems(ItemPayload payload, string expression)
    {
        var selected = new List<ItemData>();
        var (document, originals) = Document(payload);
        XmlNodeList nodes = XmlTraversal.Root(document).SelectNodes(expression)
            ?? throw new InvalidOperationException("XPath did not return a node collection.");

        foreach (XmlNode node in nodes)
        {
            if (node is not XmlElement element
                || !originals.TryGetValue(element, out ItemData? item))
            {
                throw new InvalidOperationException("Item XPath must select Item elements.");
            }

            selected.Add(item);
        }

        return selected;
    }

    public static string Serialize(ItemPayload payload)
    {
        var (document, _) = Document(payload);

        return XmlTraversal.Root(document).OuterXml;
    }

    private static (XmlDocument, Dictionary<XmlElement, ItemData>) Document(ItemPayload payload)
    {
        var document = XmlTraversal.Document();
        XmlElement root = PayloadXml.CreateResult(document, payload);

        if (payload.Result is not null)
        {
            root.InnerText = payload.Result;
        }

        var originals = new Dictionary<XmlElement, ItemData>();

        foreach (ItemData item in payload.Items)
        {
            XmlElement source = View(item);
            XmlTraversal.Validate(source);

            if (document.ImportNode(source, deep: true) is not XmlElement copy)
            {
                throw new InvalidOperationException("An XML copy must retain its element type.");
            }

            MapItems(source, copy, originals);
            root.AppendChild(copy);
        }

        return (document, originals);
    }

    private static void MapItems(
        XmlElement source, XmlElement copy, Dictionary<XmlElement, ItemData> originals)
    {
        foreach (var (original, copied) in XmlTraversal.Pairs(source, copy))
        {
            if (original.Name == "Item")
            {
                originals.Add(copied, Bind(original));
            }
        }
    }

    private static void Rebind(XmlElement source, XmlElement imported)
    {
        foreach (var (original, copied) in XmlTraversal.Pairs(source, imported))
        {
            if (bindings.TryGetValue(original, out ItemData? item))
            {
                bindings.Remove(original);
                item.Element = copied;
                item.SynchronizedRevision = null;
                bindings.Add(copied, item);
            }
        }
    }

    private sealed record WriteFrame(
        ItemData Item, XmlElement Element, IEnumerator<Attachment> Children, int Depth);
    internal sealed record Attachment(XmlElement Parent, ItemData Item);

    private static XmlElement WriteItem(XmlDocument document, ItemData root)
    {
        XmlElement element = WriteShell(document, root);
        var active = new HashSet<ItemData>(ReferenceEqualityComparer.Instance) { root };
        var pending = new Stack<WriteFrame>();
        pending.Push(new(root, element, Attachments(root, element).GetEnumerator(), 0));
        int nodes = 0;

        try
        {
            while (pending.Count > 0)
            {
                WriteFrame frame = pending.Peek();

                if (!frame.Children.MoveNext())
                {
                    pending.Pop().Children.Dispose();
                    active.Remove(frame.Item);
                    continue;
                }

                nodes += 1;
                Attachment attachment = frame.Children.Current;

                if (active.Contains(attachment.Item) || frame.Depth >= WorkLimits.DepthMax
                    || nodes > WorkLimits.NodesMax)
                {
                    throw new NotSupportedException(
                        "Item data is cyclic or exceeds its tree budget.");
                }

                if (attachment.Item.Element is { } existing)
                {
                    AttachElement(attachment.Parent, existing);
                    continue;
                }

                XmlElement child = WriteShell(document, attachment.Item);
                attachment.Parent.AppendChild(child);
                active.Add(attachment.Item);
                pending.Push(new(attachment.Item, child,
                    Attachments(attachment.Item, child).GetEnumerator(), frame.Depth + 1));
            }
        }
        finally
        {
            foreach (WriteFrame frame in pending)
            {
                frame.Children.Dispose();
            }
        }

        XmlTraversal.Validate(element);

        return element;
    }

    private static XmlElement WriteShell(XmlDocument document, ItemData item)
    {
        XmlElement element = document.CreateElement("Item");
        element.SetAttribute("type", item.Type);
        item.Element = element;
        bindings.Add(element, item);

        foreach (var attribute in item.Attributes)
        {
            element.SetAttribute(attribute.Key, attribute.Value);
        }

        foreach (var property in item.Properties)
        {
            // A projected reference has a scalar ID and an expanded Item in the wire model.
            // XML represents both through the one property containing that Item.
            if (item.PropertyItems.ContainsKey(property.Key))
            {
                continue;
            }

            XmlElement child = document.CreateElement(property.Key);
            WriteAttributes(child, item, property.Key);

            if (property.Value.ValueKind == JsonValueKind.Null)
            {
                child.SetAttribute("is_null", "1");
            }
            else
            {
                child.InnerText = Text(property.Value);
            }

            element.AppendChild(child);
        }

        return element;
    }

    private static IEnumerable<Attachment> Attachments(ItemData item, XmlElement element)
    {
        XmlDocument document = XmlTraversal.Owner(element);

        foreach (var property in item.PropertyItems)
        {
            XmlElement child = document.CreateElement(property.Key);
            WriteAttributes(child, item, property.Key);
            element.AppendChild(child);
            yield return new(child, property.Value);
        }

        foreach (var property in item.PropertyAttributes)
        {
            string name = property.Key;

            if ((property.Value.Count > 0 || name == "Relationships")
                && FindProperty(element, name) is null
                && (name != "Relationships" || item.Relationships.Count == 0))
            {
                XmlElement child = document.CreateElement(name);
                WriteAttributes(child, item, name);

                if (name == "id")
                {
                    child.InnerText = item.Attributes.GetValueOrDefault("id", "");
                }

                element.AppendChild(child);
            }
        }

        foreach (Attachment attachment in LogicalXml.Write(item, element))
        {
            yield return attachment;
        }

        if (item.Relationships.Count > 0)
        {
            XmlElement relationships = document.CreateElement("Relationships");
            WriteAttributes(relationships, item, "Relationships");
            element.AppendChild(relationships);

            foreach (ItemData relationship in item.Relationships)
            {
                yield return new(relationships, relationship);
            }
        }
    }

    private static void AttachElement(XmlElement parent, XmlElement element)
    {
        if (element.OwnerDocument != parent.OwnerDocument)
        {
            XmlTraversal.Validate(element);

            if (XmlTraversal.Owner(parent).ImportNode(element, deep: true)
                is not XmlElement imported)
            {
                throw new InvalidOperationException("An imported XML node must be an element.");
            }

            Rebind(element, imported);
            element = imported;
        }

        parent.AppendChild(element);
    }

    private static void WriteAttributes(XmlElement element, ItemData item, string name)
    {
        if (item.PropertyAttributes.TryGetValue(name, out var attributes))
        {
            foreach (var attribute in attributes)
            {
                element.SetAttribute(attribute.Key, attribute.Value);
            }
        }
    }

    private static void ReadItem(ItemData root)
    {
        if (root.Element is null)
        {
            return;
        }

        var revision = DomChanges.Version(root.Element);

        if (root.SynchronizedRevision == revision)
        {
            return;
        }

        XmlTraversal.Validate(root.Element);
        var pending = new Stack<(ItemData Item, int Depth)>();
        var synchronized = new List<ItemData>();
        pending.Push((root, 0));
        int nodes = 0;

        while (pending.Count > 0)
        {
            var (item, depth) = pending.Pop();
            nodes += 1;

            if (nodes > WorkLimits.NodesMax || depth > WorkLimits.DepthMax)
            {
                throw new NotSupportedException(
                    "Item data exceeds its transport traversal budget.");
            }

            foreach (ItemData child in ReadShell(item))
            {
                pending.Push((child, depth + 1));
            }

            synchronized.Add(item);
        }

        foreach (ItemData item in synchronized)
        {
            item.SynchronizedRevision = revision;
        }
    }

    private static List<ItemData> ReadShell(ItemData item)
    {
        var children = new List<ItemData>();
        XmlElement element = View(item);
        var previousValues = new Dictionary<string, JsonElement>(item.Properties);
        item.Type = element.GetAttribute("type");
        item.Attributes.Clear();
        item.Properties.Clear();
        item.PropertyAttributes.Clear();
        item.PropertyItems.Clear();
        item.Relationships.Clear();
        item.Logical = null;

        foreach (XmlAttribute attribute in element.Attributes)
        {
            if (attribute.Name != "type")
            {
                item.Attributes.Add(attribute.Name, attribute.Value);
            }
        }

        var names = new HashSet<string>();

        if (element.HasAttribute("id"))
        {
            names.Add("id");
        }

        var repeated = new LogicalData { Operator = "and", Terms = new(), Implicit = true };

        foreach (XmlElement property in element.ChildNodes.OfType<XmlElement>())
        {
            string name = property.Name;

            if (LogicalXml.IsGroup(name))
            {
                (item.Logical ??= new()).Add(LogicalXml.Read(property, children));
                continue;
            }

            if (!names.Add(name))
            {
                if (name == "Relationships")
                {
                    throw new NotSupportedException("Only one Relationships element is allowed.");
                }

                if (repeated.Terms?.Count == 0)
                {
                    (item.Logical ??= new()).Add(repeated);
                }

                repeated.Terms?.Add(LogicalXml.ReadCondition(property, children));
                continue;
            }

            if (name == "Relationships")
            {
                item.PropertyAttributes.Add(name, new());
                ReadRelationships(item, property, children);

                continue;
            }

            ReadProperty(item, element, property, previousValues, children);
        }

        return children;
    }

    private static void ReadRelationships(
        ItemData item, XmlElement property, List<ItemData> children)
    {
        foreach (XmlElement child in property.ChildNodes.OfType<XmlElement>())
        {
            if (child.Name != "Item")
            {
                throw new NotSupportedException("Relationships must contain Item elements.");
            }

            ItemData relationship = Bind(child);
            children.Add(relationship);
            item.Relationships.Add(relationship);
        }
    }

    private static void ReadProperty(
        ItemData item,
        XmlElement element,
        XmlElement property,
        IReadOnlyDictionary<string, JsonElement> previousValues,
        List<ItemData> pending)
    {
        string name = property.Name;

        if (property.HasAttributes)
        {
            item.PropertyAttributes[name] = property.Attributes.Cast<XmlAttribute>()
                .ToDictionary(attribute => attribute.Name, attribute => attribute.Value);
        }

        var children = property.ChildNodes.OfType<XmlElement>().ToList();

        if (children.Count > 0)
        {
            if (children.Count != 1 || children[0].Name != "Item")
            {
                throw new NotSupportedException(
                    "The managed AML transport requires one Item in nested property "
                    + $"'{name}'.");
            }

            ItemData nested = Bind(children[0]);
            pending.Add(nested);
            item.PropertyItems.Add(name, nested);
            string id = children[0].GetAttribute("id");

            if (previousValues.ContainsKey(name) && id.Length > 0)
            {
                item.Properties.Add(name, JsonSerializer.SerializeToElement(id));
            }

            return;
        }

        if (name == "id" && property.GetAttribute("condition") is "" or "eq")
        {
            if (!element.HasAttribute("id"))
            {
                item.Attributes["id"] = property.InnerText;
            }

            return;
        }

        if (property.GetAttribute("is_null") == "1")
        {
            item.Properties[name] = JsonSerializer.SerializeToElement<string?>(null);
        }
        else if (previousValues.TryGetValue(name, out JsonElement previous)
            && previous.ValueKind != JsonValueKind.Null && Text(previous) == property.InnerText)
        {
            item.Properties[name] = previous;
        }
        else
        {
            item.Properties[name] = JsonSerializer.SerializeToElement(property.InnerText);
        }
    }

    private static string Text(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.String)
        {
            return value.GetString() ?? "";
        }

        return value.GetRawText();
    }
}
