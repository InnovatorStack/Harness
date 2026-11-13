using System.Xml;
using InnovatorHarness.Managed;

namespace Aras.Server.Core;

public class ServerEventArgs
{
    private const string InputReloadGap =
        "Replacing Get/Update input before base delegation requires its captured "
        + "request node and current document to be transferred separately.";
    private readonly Remote remote;
    private readonly XmlDocument? input;
    private readonly XmlElement? originalRoot;
    private readonly XmlElement? originalRequest;

    public ServerEventArgs(Remote remote, XmlDocument? input = null)
    {
        this.remote = remote;
        this.input = input;

        if (input is not null)
        {
            originalRoot = input.DocumentElement;
            originalRequest = SingleRequest(input);
        }
    }

    private static XmlElement? SingleRequest(XmlDocument document)
    {
        if (document.DocumentElement is { Name: "Item" } root)
        {
            return root;
        }

        XmlNodeList? selected = document.SelectNodes("Item|AML/Item|//Result/Item");

        if (selected is { Count: 1 } && selected[0] is XmlElement item)
        {
            return item;
        }

        return null;
    }

    protected void ApplyBase(string name, XmlDocument output)
    {
        var document = input
            ?? throw new InvalidOperationException("A base delegate requires its event context.");
        XmlElement request;

        if (name is "onGet" or "onUpdate")
        {
            request = CapturedInput(document);
        }
        else
        {
            request = RequestXml.Input(document);
        }

        var context = new ItemPayload { Items = new() { ItemXml.Bind(request) } };
        var origins = remote.Origins.Capture(context);
        bool wrapped = !ReferenceEquals(request, document.DocumentElement);
        string xml = request.OuterXml;

        if (wrapped)
        {
            xml = document.OuterXml;
        }

        var payload = remote.Call("eventBase", new { name, xml, origins, document = wrapped },
            change => Synchronize(document, request, change));
        ResponseXml.Write(output, payload);
    }

    private XmlElement CapturedInput(XmlDocument document)
    {
        if (!ReferenceEquals(originalRoot, document.DocumentElement))
        {
            remote.Unsupported(InputReloadGap);
        }

        XmlElement current;

        try
        {
            current = RequestXml.Input(document);
        }
        catch (Exception exception)
            when (exception is InvalidOperationException or NotSupportedException)
        {
            remote.Unsupported(InputReloadGap);

            throw;
        }

        if (!ReferenceEquals(originalRequest, current))
        {
            remote.Unsupported(InputReloadGap);
        }

        return current;
    }

    private void Synchronize(XmlDocument document, XmlElement request, BaseInputChange change)
    {
        try
        {
            if (change.Request is { } patch)
            {
                RequestXml.Synchronize(request, patch);
            }

            remote.Origins.Apply(new ItemPayload { Items = new() { ItemXml.Bind(request) } },
                change.Origins);

            if (change.Document is { } input)
            {
                XmlDocument current = ManagedDocuments.Read(input);
                document.RemoveAll();

                foreach (XmlNode node in current.ChildNodes)
                {
                    document.AppendChild(document.ImportNode(node, deep: true));
                }

                remote.Origins.Apply(ResponseXml.Read(document), change.DocumentOrigins);
            }
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
