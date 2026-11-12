using System.Text.Json;
using System.Text.Json.Serialization;

namespace InnovatorHarness.Managed;

public sealed class LogicalData
{
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Operator { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<LogicalData>? Terms { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Name { get; set; }
    public Dictionary<string, string> Attributes { get; set; } = new();
    public JsonElement Value { get; set; } = JsonSerializer.SerializeToElement<string?>(null);
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public ItemData? Item { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public bool Implicit { get; set; }
}
