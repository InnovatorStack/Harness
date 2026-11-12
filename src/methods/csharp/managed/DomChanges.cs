using System.Runtime.CompilerServices;
using System.Xml;

namespace InnovatorHarness.Managed;

/// <summary>
/// Observe live DOM mutations without retaining documents after their world closes.
/// </summary>
internal sealed class DomChanges
{
    private static readonly ConditionalWeakTable<XmlDocument, DomChanges> documents = new();
    private long revision;

    private DomChanges(XmlDocument document)
    {
        document.NodeChanged += Changed;
        document.NodeInserted += Changed;
        document.NodeRemoved += Changed;
    }

    internal static long Version(XmlElement element)
    {
        var document = XmlTraversal.Owner(element);
        var changes = documents.GetValue(document, owner => new DomChanges(owner));

        return Volatile.Read(ref changes.revision);
    }

    private void Changed(object? sender, XmlNodeChangedEventArgs arguments)
    {
        _ = sender;
        _ = arguments;
        Interlocked.Increment(ref revision);
    }
}
