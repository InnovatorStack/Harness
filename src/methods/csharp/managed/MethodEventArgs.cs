using System.Xml;
using InnovatorHarness.Managed;

namespace Aras.Server.Core;

public sealed class OnBeforeUpdateEventArgs
{
    public string Id { get; }
    public IEnumerable<string> IdList { get; }

    public OnBeforeUpdateEventArgs(Remote remote, XmlDocument? input = null)
    {
        var data = EventMetadata.Require(remote, "onBeforeUpdate");
        Id = EventMetadata.Required(data.Id, "id");
        IdList = data.Ids();
    }
}

public sealed class OnAfterAddEventArgs
{
    public string TypeId { get; }
    public string Id { get; }
    public IEnumerable<string> IdList { get; }

    public OnAfterAddEventArgs(Remote remote, XmlDocument? input = null)
    {
        var data = EventMetadata.Require(remote, "onAfterAdd");
        TypeId = EventMetadata.Required(data.TypeId, "typeId");
        Id = EventMetadata.Required(data.Id, "id");
        IdList = data.Ids();
    }
}

public sealed class OnAfterUpdateEventArgs
{
    public string TypeId { get; }
    public string? Id { get; }
    public IReadOnlyDictionary<string, string> OldIdsNewIdsMap { get; }
    public IEnumerable<string> NewItemsIds => OldIdsNewIdsMap.Values;

    public OnAfterUpdateEventArgs(Remote remote, XmlDocument? input = null)
    {
        var data = EventMetadata.Require(remote, "onAfterUpdate");
        TypeId = EventMetadata.Required(data.TypeId, "typeId");
        Id = data.Id;
        OldIdsNewIdsMap = data.Mapping();
    }
}

public sealed class AfterVersionEventArgs
{
    public string TypeId { get; }
    public string NewItemId { get; }
    public IReadOnlyDictionary<string, string> OldIdsNewIdsMap { get; }
    public IEnumerable<string> NewItemsIds => OldIdsNewIdsMap.Values;

    public AfterVersionEventArgs(Remote remote, XmlDocument? input = null)
    {
        var data = EventMetadata.Require(remote, "onAfterVersion");
        TypeId = EventMetadata.Required(data.TypeId, "typeId");
        NewItemId = EventMetadata.Required(data.NewItemId, "newItemId");
        OldIdsNewIdsMap = data.Mapping();
    }
}
