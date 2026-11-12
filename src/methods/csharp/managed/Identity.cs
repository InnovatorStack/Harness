using InnovatorHarness.Managed;

namespace Aras.Server.Security;

public sealed class Identity
{
    public string Id { get; }
    public string Name { get; }

    private Identity(string id, string name)
    {
        Id = id;
        Name = name;
    }

    public static Identity? GetByName(string name)
    {
        var remote = RemoteContext.Current;
        var payload = remote.Call("securityIdentity", new { name });

        if (payload.Items.Count == 0)
        {
            return null;
        }

        var item = new Item(payload, remote);

        return new Identity(item.getID(), item.getProperty("name"));
    }
}
