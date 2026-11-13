using System.Xml;
using InnovatorHarness.Managed;

namespace Aras.Server.Core;

public class ServerEventArgs
{
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

        XmlElement? currentRequest = SingleRequest(document);
        object arguments = CallbackInput(name, document, request);
        var payload = remote.Call("eventBase", arguments,
            change => Synchronize(document, request, currentRequest, change));
        ResponseXml.Write(output, payload);
    }

    private object CallbackInput(string name, XmlDocument document, XmlElement request)
    {
        var context = new ItemPayload { Items = new() { ItemXml.Bind(request) } };
        var origins = remote.Origins.Capture(context);
        bool detached = !IsAttached(request, document);
        bool wrapped = !detached && !ReferenceEquals(request, document.DocumentElement);
        string xml = request.OuterXml;
        string? currentDocument = null;
        OriginFrame? currentOrigins = null;

        if (wrapped)
        {
            xml = document.OuterXml;
        }

        if (detached)
        {
            currentDocument = document.OuterXml;
            currentOrigins = remote.Origins.Capture(ResponseXml.Read(document));
        }

        return new { name, xml, origins, document = wrapped, currentDocument, currentOrigins };
    }

    private XmlElement CapturedInput(XmlDocument document)
    {
        if (originalRequest is null)
        {
            remote.Unsupported("A native base action requires one captured request Item.");

            throw new InvalidOperationException("Missing captured base request.");
        }

        if (!ReferenceEquals(originalRoot, document.DocumentElement)
            && IsAttached(originalRequest, document))
        {
            remote.Unsupported("Moving a retained base request into another XML container "
                + "requires a qualified XML mapping.");
        }

        return originalRequest;
    }

    private static bool IsAttached(XmlElement request, XmlDocument document)
    {
        XmlNode? current = request;

        for (int depth = 0; current is not null && depth <= WorkLimits.DepthMax; depth++)
        {
            if (ReferenceEquals(current, document))
            {
                return true;
            }

            current = current.ParentNode;
        }

        if (current is not null)
        {
            throw new NotSupportedException("A base request exceeds its ancestry limit.");
        }

        return false;
    }

    private void Synchronize(
        XmlDocument document, XmlElement request,
        XmlElement? currentRequest, BaseInputChange change)
    {
        try
        {
            if (change.Request is { } patch)
            {
                RequestXml.Synchronize(request, patch);
            }

            remote.Origins.Apply(new ItemPayload { Items = new() { ItemXml.Bind(request) } },
                change.Origins);

            if (change.RetainedDocument is { } retained)
            {
                if (currentRequest is null || ReferenceEquals(currentRequest, request))
                {
                    throw new InvalidOperationException(
                        "Missing separately retained document Item.");
                }

                RequestXml.Synchronize(currentRequest, retained);
                remote.Origins.Apply(
                    new ItemPayload { Items = new() { ItemXml.Bind(currentRequest) } },
                    change.RetainedOrigins);
            }

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
            else if (change.DocumentChange is { } documentChange)
            {
                RequestXml.Synchronize(RequestXml.Input(document), documentChange);
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
