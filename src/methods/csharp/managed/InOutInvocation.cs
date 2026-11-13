using System.Xml;
using Aras.Server.Core;

namespace InnovatorHarness.Managed;

public sealed class InOutInvocation
{
    private readonly Item context;
    public Remote Remote { get; }
    public IOMConnection Connection { get; }
    public XmlDocument Input { get; }
    public XmlDocument Output { get; }
    public ItemPayload ContextPayload => context.DocumentPayload;

    public InOutInvocation(ItemPayload payload, Remote remote)
    {
        Remote = remote;
        Connection = new IOMConnection(remote);
        context = new Item(payload, remote);

        Input = context.dom
            ?? throw new InvalidOperationException("Missing Method input document.");

        Output = XmlTraversal.Document();
        PayloadXml.CreateResult(Output, new ItemPayload(), wrapEnvelope: true);
    }

    public Item Result()
    {
        try
        {
            return new Item(ResponseXml.Read(Output), Remote);
        }
        catch (NotSupportedException exception)
        {
            Remote.Unsupported(exception.Message);

            throw;
        }
    }
}
