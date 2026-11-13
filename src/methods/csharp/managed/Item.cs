using System.Text.Json;
using System.Xml;

namespace InnovatorHarness.Managed;

public interface IArasMethod
{
    ItemPayload ContextPayload { get; }

    Item Execute();
}

public class Item
{
    public const string XPathResultItem = "//Result/Item";
    private const string SoapNamespace =
        "(namespace-uri()='http://schemas.xmlsoap.org/soap/envelope/' or namespace-uri()='')";
    private const string FaultPath = "/*[local-name()='Envelope' and " + SoapNamespace
        + "]/*[local-name()='Body' and " + SoapNamespace
        + "]/*[local-name()='Fault' and " + SoapNamespace + "]";

    public XmlElement? node { get; set; }
    public XmlDocument? dom { get; set; }
    public XmlNodeList? nodeList { get; set; }
    protected Remote Remote { get; }
    protected CallContext CCO { get; }

    public ItemPayload Payload
    {
        get
        {
            var payload = new ItemPayload();

            if (node is { } element)
            {
                payload.Items.Add(ItemXml.Bind(element));
            }
            else if (nodeList is { } items)
            {
                if (items.Count > WorkLimits.NodesMax)
                {
                    Remote.Unsupported("Item payload exceeds its selection limit.");
                }

                foreach (XmlNode selected in items)
                {
                    payload.Items.Add(ItemXml.Bind(RequireItem(selected)));
                }
            }
            else
            {
                return DocumentPayload;
            }

            try
            {
                ItemXml.Synchronize(payload);
            }
            catch (NotSupportedException exception)
            {
                Remote.Unsupported(exception.Message);

                throw;
            }

            return payload;
        }
    }

    public ItemPayload DocumentPayload => ReadDocument(dom
        ?? throw new InvalidOperationException("The Item has no XML document."));

    public Item(ItemPayload payload, Remote remote)
        : this(ItemDocuments.Create(payload), null, null, remote)
    {
        InitializeSelection();
    }

    private Item(XmlDocument? document, XmlElement? element, XmlNodeList? items, Remote remote)
    {
        dom = document;
        node = element;
        nodeList = items;
        Remote = remote;
        CCO = new CallContext(remote);
    }

    protected ItemPayload ReadDocument(XmlDocument document) => ItemDocuments.Read(document);

    private XmlElement Element
    {
        get
        {
            if (dom is null)
            {
                throw new InvalidOperationException("The Item has no XML document.");
            }

            return RequireItem(node);
        }
    }
    private ItemData Node => ItemXml.Bind(Element);

    private static XmlElement RequireItem(XmlNode? selected)
    {
        if (selected is XmlElement { Name: "Item" } element)
        {
            return element;
        }

        throw new InvalidOperationException("This operation requires one Item element.");
    }

    private XmlElement RequireAttached()
    {
        XmlElement element = Element;
        XmlNode? ancestor = element;
        int depth = 0;

        while (ancestor is not null && !ReferenceEquals(ancestor, dom))
        {
            if (++depth > WorkLimits.DepthMax)
            {
                Remote.Unsupported("Item attachment exceeds its nesting limit.");
            }

            ancestor = ancestor.ParentNode;
        }

        if (dom is null || ancestor is null)
        {
            throw new InvalidOperationException("The selected Item is detached from its document.");
        }

        return element;
    }

    public bool isError() => dom?.SelectSingleNode(FaultPath) is not null;

    public bool isNew() => getAttribute("isNew") == "1";

    public string getErrorString() => dom?.SelectSingleNode(FaultPath + "/faultstring")
        ?.InnerText ?? "";

    public string getErrorCode() => dom?.SelectSingleNode(FaultPath + "/faultcode")
        ?.InnerText ?? "";

    public string getResult() => dom?.SelectSingleNode("//Result")?.InnerText ?? "";

    public int getItemCount()
    {
        if (dom is null)
        {
            return -1;
        }

        if (nodeList is { } items)
        {
            return items.Count;
        }

        if (isError())
        {
            if (getErrorCode() == "0")
            {
                return 0;
            }

            return -1;
        }

        if (node is null)
        {
            return -1;
        }

        return 1;
    }

    public string getID()
    {
        if (Element.HasAttribute("id"))
        {
            return Element.GetAttribute("id");
        }

        return getProperty("id");
    }

    public void setID(string id) => setAttribute("id", id);

    public string getType() => Element.GetAttribute("type");

    public void setType(string type) => Element.SetAttribute("type", type);

    public string getAction() => getAttribute("action", "get");

    public void setAction(string action) => setAttribute("action", action);

    public string getAttribute(string name, string fallback = "")
    {
        if (Element.HasAttribute(name))
        {
            return Element.GetAttribute(name);
        }

        return fallback;
    }

    public void setAttribute(string name, string value)
    {
        Element.SetAttribute(name, value);

        if (name == "id" && ItemXml.FindProperty(Element, "id") is { } property)
        {
            property.InnerText = value;
        }
    }

    public Item getItemByIndex(int index)
    {
        if (nodeList is null)
        {
            if (index != 0)
            {
                throw new InvalidOperationException("The Item is not a collection.");
            }

            return this;
        }

        if (index < 0 || index >= nodeList.Count)
        {
            throw new IndexOutOfRangeException("The Item index is outside its collection.");
        }

        return new Item(dom, RequireItem(nodeList[index]), null, Remote);
    }

    public string getProperty(string name, string fallback = "")
    {
        if (name == "id" && Element.HasAttribute("id"))
        {
            string id = Element.GetAttribute("id");

            if (id.Length > 0)
            {
                return id;
            }

            return fallback;
        }

        XmlElement? property = ItemXml.FindProperty(Element, name);

        if (property is null || property.GetAttribute("is_null") == "1")
        {
            return fallback;
        }

        XmlElement? nested = property.ChildNodes.OfType<XmlElement>().FirstOrDefault();

        if (nested is not null)
        {
            if (Node.Properties.ContainsKey(name) && nested.Name == "Item"
                && nested.HasAttribute("id"))
            {
                return nested.GetAttribute("id");
            }

            return fallback;
        }

        return property.InnerText;
    }

    public void setProperty(string name, string? value)
    {
        if (name == "id")
        {
            setID(value ?? "");

            return;
        }

        XmlElement property = ItemXml.Property(Node, name);
        property.InnerText = value ?? "";

        if (value is null)
        {
            property.SetAttribute("is_null", "1");
        }
        else
        {
            property.RemoveAttribute("is_null");
        }

        Node.Properties[name] = JsonSerializer.SerializeToElement(value);
    }

    public void removeProperty(string name)
    {
        var properties = Element.ChildNodes.OfType<XmlElement>()
            .Where(child => child.Name == name).ToList();

        foreach (XmlElement property in properties)
        {
            Element.RemoveChild(property);
        }

        Node.Properties.Remove(name);
        Node.PropertyAttributes.Remove(name);
        Node.PropertyItems.Remove(name);
    }

    public string getPropertyAttribute(string property, string attribute, string fallback = "")
    {
        XmlElement? element = ItemXml.FindProperty(Element, property);

        if (element is not null && element.HasAttribute(attribute))
        {
            return element.GetAttribute(attribute);
        }

        return fallback;
    }

    public void setPropertyAttribute(string property, string attribute, string value)
    {
        ItemXml.Property(Node, property).SetAttribute(attribute, value);
    }

    public Item setPropertyItem(string name, Item item)
    {
        _ = RequireAttached();
        ItemData parent = Node;
        XmlElement source = item.Element;
        XmlElement property = ItemXml.Property(parent, name);
        XmlElement copy = PropertyItems.Replace(property, source);
        item.node = copy;
        item.dom = dom;
        parent.Properties.Remove(name);

        return item;
    }

    public Item? getPropertyItem(string name)
    {
        XmlElement? property = ItemXml.FindProperty(Element, name);
        XmlElement? item = property?.ChildNodes.OfType<XmlElement>()
            .FirstOrDefault(child => child.Name == "Item");

        if (item is null)
        {
            return null;
        }

        return new Item(dom, item, null, Remote);
    }

    public Item getRelationships() => SelectItems(Element, "Relationships/Item", true);

    public Item getRelationships(string type)
    {
        return SelectItems(Element, "Relationships/Item[@type='" + type + "']", true);
    }

    public void addRelationship(Item item)
    {
        XmlElement relationships = ItemXml.Property(Node, "Relationships");
        item.node = PropertyItems.Append(relationships, item.Element);
        item.dom = dom;
    }

    public Item newItem(string type = "", string action = "")
        => getInnovator().newItem(type, action);

    public Innovator getInnovator() => new(Remote);

    public Item apply() => apply(null);

    public Item apply(string? action)
    {
        _ = RequireAttached();

        if (action is not null)
        {
            setAction(action);
        }

        return new Item(Remote.Call("apply", Payload), Remote);
    }

    public void fetchRelationships(string type)
    {
        Item query = newItem(type, "get");
        query.setProperty("source_id", getID());
        Item result = query.apply();

        if (result.isError() && result.getErrorCode() != "0")
        {
            throw new InvalidOperationException(result.getErrorString());
        }

        var existing = Relationships()
            .Where(item => item.GetAttribute("type")
                .Equals(type, StringComparison.OrdinalIgnoreCase))
            .ToList();

        foreach (XmlElement relationship in existing)
        {
            var parent = relationship.ParentNode
                ?? throw new InvalidOperationException("Attached relationship has no parent.");
            parent.RemoveChild(relationship);
        }

        foreach (ItemData relationship in result.Payload.Items)
        {
            ItemXml.Attach(ItemXml.Property(Node, "Relationships"), relationship);
        }
    }

    public void loadAML(string xml)
    {
        dom ??= XmlTraversal.Document();

        try
        {
            XmlTraversal.Load(dom, xml);
        }
        catch
        {
            dom = null;

            throw;
        }
        finally
        {
            InitializeSelection();
        }
    }

    public Item getItemsByXPath(string expression)
    {
        XmlDocument document = dom
            ?? throw new InvalidOperationException("The Item has no XML document.");
        XmlNode context = node ?? (XmlNode)document;

        return SelectItems(context, expression, false);
    }

    public override string ToString()
    {
        if (dom is null)
        {
            return "";
        }

        if (dom.DocumentElement is { } root)
        {
            XmlTraversal.Validate(root);
        }

        return dom.OuterXml;
    }

    private void InitializeSelection()
    {
        node = null;
        nodeList = null;
        XmlNodeList? selected = dom?.SelectNodes("Item|AML/Item|//Result/Item");

        if (selected?.Count == 1)
        {
            node = RequireItem(selected[0]);
        }
        else if (selected is { Count: > 1 })
        {
            nodeList = selected;
        }
    }

    private Item SelectItems(XmlNode context, string expression, bool collection)
    {
        XmlNodeList selected = context.SelectNodes(expression)
            ?? throw new InvalidOperationException("XPath did not return a node collection.");

        if (selected.Count > WorkLimits.NodesMax)
        {
            Remote.Unsupported("Item XPath exceeds its selection limit.");
        }

        foreach (XmlNode selectedNode in selected)
        {
            if (selectedNode is not XmlElement { Name: "Item" })
            {
                throw new InvalidOperationException("Item XPath must select Item elements.");
            }
        }

        if (!collection && selected.Count == 1)
        {
            return new Item(dom, RequireItem(selected[0]), null, Remote);
        }

        return new Item(dom, null, selected, Remote);
    }

    private IEnumerable<XmlElement> Relationships()
    {
        return ItemXml.FindProperty(Element, "Relationships")?.ChildNodes.OfType<XmlElement>()
            ?? Enumerable.Empty<XmlElement>();
    }
}
