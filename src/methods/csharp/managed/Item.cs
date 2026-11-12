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
    private readonly ItemPayload payload;

    public ItemPayload Payload
    {
        get
        {
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

    public XmlElement node => ItemXml.View(Node);
    public XmlDocument dom => ItemXml.ViewDocument(Payload);
    protected Remote Remote
    {
        get;
    }
    protected CallContext CCO { get; }

    public Item(ItemPayload payload, Remote remote)
    {
        this.payload = payload;
        Remote = remote;
        CCO = new CallContext(remote);
        ItemXml.Initialize(payload);
    }

    private ItemData Node
    {
        get
        {
            if (payload.Error is not null || payload.Items.Count != 1)
            {
                throw new InvalidOperationException("This operation requires one non-error Item.");
            }

            return payload.Items[0];
        }
    }

    public bool isError() => payload.Error is not null;

    public bool isNew() => getAttribute("isNew") == "1";

    public string getErrorString() => payload.Error?.Message ?? "";

    public string getErrorCode() => payload.Error?.Code ?? "";

    public string getResult() => payload.Result ?? "";

    public int getItemCount()
    {
        if (isError())
        {
            return -1;
        }

        return payload.Items.Count;
    }

    public string getID()
    {
        if (node.HasAttribute("id"))
        {
            return node.GetAttribute("id");
        }

        return getProperty("id");
    }

    public void setID(string id) => setAttribute("id", id);

    public string getType() => node.GetAttribute("type");

    public void setType(string type) => node.SetAttribute("type", type);

    public string getAction() => getAttribute("action", "get");

    public void setAction(string action) => setAttribute("action", action);

    public string getAttribute(string name, string fallback = "")
    {
        if (node.HasAttribute(name))
        {
            return node.GetAttribute(name);
        }

        return fallback;
    }

    public void setAttribute(string name, string value)
    {
        node.SetAttribute(name, value);

        if (name == "id" && ItemXml.FindProperty(node, "id") is { } property)
        {
            property.InnerText = value;
        }
    }

    public Item getItemByIndex(int index) => Wrap(new List<ItemData> { payload.Items[index] });

    public string getProperty(string name, string fallback = "")
    {
        if (name == "id" && node.HasAttribute("id"))
        {
            string id = node.GetAttribute("id");

            if (id.Length > 0)
            {
                return id;
            }

            return fallback;
        }

        XmlElement? property = ItemXml.FindProperty(node, name);

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
        var properties = node.ChildNodes.OfType<XmlElement>()
            .Where(child => child.Name == name).ToList();

        foreach (XmlElement property in properties)
        {
            node.RemoveChild(property);
        }

        Node.Properties.Remove(name);
        Node.PropertyAttributes.Remove(name);
        Node.PropertyItems.Remove(name);
    }

    public string getPropertyAttribute(string property, string attribute, string fallback = "")
    {
        XmlElement? element = ItemXml.FindProperty(node, property);

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

    public void setPropertyItem(string name, Item item)
    {
        XmlElement property = ItemXml.Property(Node, name);
        property.InnerText = "";
        property.RemoveAttribute("is_null");
        Node.Properties.Remove(name);
        ItemXml.Attach(property, item.Node);
    }

    public Item? getPropertyItem(string name)
    {
        XmlElement? property = ItemXml.FindProperty(node, name);
        XmlElement? item = property?.ChildNodes.OfType<XmlElement>()
            .FirstOrDefault(child => child.Name == "Item");

        if (item is null)
        {
            return null;
        }

        return Wrap(new List<ItemData> { ItemXml.Bind(item) });
    }

    public Item getRelationships() => Wrap(Relationships().Select(ItemXml.Bind).ToList());

    public Item getRelationships(string type)
    {
        return Wrap(Relationships()
            .Where(item => item.GetAttribute("type")
                .Equals(type, StringComparison.OrdinalIgnoreCase))
            .Select(ItemXml.Bind).ToList());
    }

    public void addRelationship(Item item)
    {
        ItemXml.Attach(ItemXml.Property(Node, "Relationships"), item.Node);
    }

    public Item newItem(string type = "", string action = "")
        => getInnovator().newItem(type, action);

    public Innovator getInnovator() => new(Remote);

    public Item apply()
    {
        if (isError() || payload.Items.Count != 1)
        {
            throw new InvalidOperationException("apply requires one non-error Item.");
        }

        return new Item(Remote.Call("apply", Payload), Remote);
    }

    public Item apply(string? action)
    {
        if (action is not null)
        {
            setAction(action);
        }

        return apply();
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

        foreach (ItemData relationship in result.payload.Items)
        {
            ItemXml.Attach(ItemXml.Property(Node, "Relationships"), relationship);
        }
    }

    public void loadAML(string xml)
    {
        ItemPayload parsed = ItemXml.Parse(xml);
        payload.Items = parsed.Items;
        payload.Error = parsed.Error;
        payload.Result = parsed.Result;
        payload.Messages = parsed.Messages;
    }

    public Item getItemsByXPath(string expression)
    {
        return Wrap(ItemXml.SelectItems(payload, expression));
    }

    public override string ToString() => ItemXml.Serialize(payload);

    private IEnumerable<XmlElement> Relationships()
    {
        return ItemXml.FindProperty(node, "Relationships")?.ChildNodes.OfType<XmlElement>()
            ?? Enumerable.Empty<XmlElement>();
    }

    private Item Wrap(List<ItemData> items) => new(new ItemPayload { Items = items }, Remote);
}
