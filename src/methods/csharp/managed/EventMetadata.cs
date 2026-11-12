using System.Collections.ObjectModel;

namespace InnovatorHarness.Managed;

public sealed class EventMetadata
{
    public string Kind { get; init; } = "";
    public string? Id { get; init; }
    public string? TypeId { get; init; }
    public string? NewItemId { get; init; }
    public string[]? IdList { get; init; }
    public Dictionary<string, string>? OldIdsNewIdsMap { get; init; }

    public static EventMetadata Require(Remote remote, string kind)
    {
        var data = remote.EventData;

        if (data is null || data.Kind != kind)
        {
            throw new InvalidOperationException($"This Method requires '{kind}' event data.");
        }

        return data;
    }

    public static string Required(string? value, string name)
    {
        return value ?? throw new InvalidOperationException($"Missing event data '{name}'.");
    }

    public IReadOnlyList<string> Ids()
    {
        var ids = IdList ?? throw new InvalidOperationException("Missing event ID list.");

        return Array.AsReadOnly(ids.ToArray());
    }

    public IReadOnlyDictionary<string, string> Mapping()
    {
        var mapping = OldIdsNewIdsMap
            ?? throw new InvalidOperationException("Missing event generation mapping.");

        return new ReadOnlyDictionary<string, string>(new Dictionary<string, string>(mapping));
    }
}
