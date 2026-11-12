using System.Text.Json;
using System.Text.Json.Serialization;

namespace InnovatorHarness.Managed;

[JsonSourceGenerationOptions(JsonSerializerDefaults.Web,
    MaxDepth = WorkLimits.DepthMax,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(Invocation))]
[JsonSerializable(typeof(ItemPayload))]
internal sealed partial class ProtocolJson : JsonSerializerContext
{
}
