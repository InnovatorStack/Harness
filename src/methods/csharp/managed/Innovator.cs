namespace InnovatorHarness.Managed;

public sealed class Innovator(Remote remote)
{
    public Innovator(Aras.IOM.IServerConnection connection)
        : this(ConnectionRemote(connection))
    {
    }

    private static Remote ConnectionRemote(Aras.IOM.IServerConnection connection)
    {
        if (connection is Aras.Server.Core.IOMConnection native)
        {
            return native.Remote;
        }

        throw new NotSupportedException("Only the active local connection is supported.");
    }

    public Item newItem(string type = "", string action = "")
    {
        var item = new ItemData { Type = type };
        item.Attributes["isNew"] = "1";
        item.Attributes["isTemp"] = "1";

        if (action.Length > 0)
        {
            item.Attributes["action"] = action;
        }

        if (action == "add")
        {
            item.Attributes["id"] = getNewID();
        }

        return new Item(new ItemPayload { Items = new() { item } }, remote);
    }

    public Item newError(string message)
    {
        return new Item(new ItemPayload { Error = new("ApplicationError", message) }, remote);
    }

    public string getNewID()
    {
        return remote.Call("newId", new { }).Result
            ?? throw new InvalidOperationException("The Item ID port returned no ID.");
    }

    public Item newResult(string value)
    {
        return new Item(new ItemPayload { Result = value }, remote);
    }

    public string getUserID()
    {
        ItemPayload session = remote.Call("session", new
        {
        });

        return session.Result
            ?? throw new InvalidOperationException("The current session has no user.");
    }

    public Item applyAML(string xml)
    {
        return new Item(remote.Call("aml", new
        {
            xml
        }), remote);
    }

    public Item applyMethod(string name, string body)
    {
        return new Item(remote.Call("method", new
        {
            name,
            body
        }), remote);
    }

    public Item applySQL(string sql)
    {
        return new Item(remote.Call("sql", new
        {
            sql
        }), remote);
    }

    public Item applySQLWithParameters(string sql, string parameters)
    {
        return new Item(remote.Call("sql", new
        {
            sql,
            parameters
        }), remote);
    }

    public Item getItemById(string type, string id)
    {
        Item request = newItem(type, "get");
        request.setID(id);

        return request.apply();
    }
}
