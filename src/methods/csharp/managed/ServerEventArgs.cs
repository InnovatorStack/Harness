using System.Xml;
using InnovatorHarness.Managed;

namespace Aras.Server.Core;

public class ServerEventArgs(Remote remote, XmlDocument input)
{
    protected void ApplyBase(string name, XmlDocument output)
    {
        var payload = remote.Call("eventBase", new { name, xml = input.OuterXml });
        ResponseXml.Write(output, payload);
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
