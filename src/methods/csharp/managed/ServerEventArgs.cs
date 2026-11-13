using System.Xml;
using InnovatorHarness.Managed;

namespace Aras.Server.Core;

public class ServerEventArgs(Remote remote, XmlDocument? input = null)
{
    protected void ApplyBase(string name, XmlDocument output)
    {
        var document = input
            ?? throw new InvalidOperationException("A base delegate requires its event context.");
        XmlElement request = RequestXml.Input(document);
        var context = new ItemPayload { Items = new() { ItemXml.Bind(request) } };
        var origins = remote.Origins.Capture(context);
        var payload = remote.Call("eventBase", new { name, xml = request.OuterXml, origins },
            change => Synchronize(document, change));
        ResponseXml.Write(output, payload);
    }

    private void Synchronize(XmlDocument document, RequestChange change)
    {
        try
        {
            RequestXml.Synchronize(document, change);
            XmlElement request = RequestXml.Input(document);
            remote.Origins.Apply(new ItemPayload { Items = new() { ItemXml.Bind(request) } },
                change.Origins);
        }
        catch (Exception exception)
            when (exception is NotSupportedException or InvalidOperationException)
        {
            remote.Unsupported(exception.Message);
        }
    }
}

public sealed class OnGetEventArgs(Remote remote, XmlDocument input)
    : ServerEventArgs(remote, input)
{
    public void BaseGetItem(XmlDocument output) => ApplyBase("onGet", output);
}

public sealed class OnAddEventArgs(Remote remote, XmlDocument input)
    : ServerEventArgs(remote, input)
{
    public void BaseAddItem(XmlDocument output) => ApplyBase("onAdd", output);
}

public sealed class OnUpdateEventArgs(Remote remote, XmlDocument input)
    : ServerEventArgs(remote, input)
{
    public void BaseUpdateItem(XmlDocument output) => ApplyBase("onUpdate", output);
}

public sealed class OnDeleteEventArgs(Remote remote, XmlDocument input)
    : ServerEventArgs(remote, input)
{
    public void BaseDeleteItem(XmlDocument output) => ApplyBase("onDelete", output);
}

public sealed class OnLockEventArgs(Remote remote, XmlDocument input)
    : ServerEventArgs(remote, input)
{
    public void BaseLockItem(XmlDocument output) => ApplyBase("onLock", output);
}

public sealed class OnUnlockEventArgs(Remote remote, XmlDocument input)
    : ServerEventArgs(remote, input)
{
    public void BaseUnlockItem(XmlDocument output) => ApplyBase("onUnlock", output);
}

public sealed class OnPromoteEventArgs(Remote remote, XmlDocument input)
    : ServerEventArgs(remote, input)
{
    public void BasePromoteItem(XmlDocument output) => ApplyBase("onPromote", output);
}
