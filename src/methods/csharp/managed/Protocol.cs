using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.Json.Serialization.Metadata;
using System.Text;
using System.Xml;

namespace InnovatorHarness.Managed;

public sealed class ItemData
{
    internal XmlElement? Element { get; set; }
    internal long? SynchronizedRevision { get; set; }
    public string Type { get; set; } = "";
    public Dictionary<string, string> Attributes { get; set; } = new();
    public Dictionary<string, JsonElement> Properties { get; set; } = new();
    public Dictionary<string, Dictionary<string, string>> PropertyAttributes { get; set; } = new();
    public Dictionary<string, ItemData> PropertyItems { get; set; } = new();
    public List<ItemData> Relationships { get; set; } = new();
    public List<LogicalData>? Logical { get; set; }
}

public sealed record ItemMessage(string Name, string Value);

public sealed record ItemError(string Code, string Message);

public sealed class ItemPayload
{
    public List<ItemData> Items { get; set; } = new();
    public ItemError? Error { get; set; }
    public string? Result { get; set; }
    public List<ItemMessage>? Messages { get; set; }
}

public sealed record Invocation(
    string Kind,
    string Id,
    string? Assembly,
    string? TypeName,
    ItemPayload? Context,
    EventMetadata? EventData,
    JsonElement Payload,
    string? Error);

public sealed class Protocol
{
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        MaxDepth = WorkLimits.DepthMax,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        TypeInfoResolver = JsonTypeInfoResolver.Combine(
            ProtocolJson.Default, new DefaultJsonTypeInfoResolver())
    };
    private readonly TextWriter output;
    private readonly object outputLock = new();
    private readonly ConcurrentDictionary<string, TaskCompletionSource<Invocation>> callbacks
        = new();
    private long nextCallback;
    private bool stopped;
    private readonly object stateLock = new();

    public Protocol(TextWriter output)
    {
        this.output = output;
    }

    public void Write(object message)
    {
        var encoded = JsonSerializer.Serialize(message, Json);

        if (Encoding.UTF8.GetByteCount(encoded) > WorkLimits.MessageBytesMax)
        {
            throw new InvalidOperationException("Managed message exceeds its byte limit.");
        }

        lock (outputLock)
        {
            output.WriteLine(encoded);
            output.Flush();
        }
    }

    public ItemPayload Call(string invocationId, string operation, object payload)
    {
        var id = Interlocked.Increment(ref nextCallback).ToString();
        var completion = new TaskCompletionSource<Invocation>(
            TaskCreationOptions.RunContinuationsAsynchronously);

        lock (stateLock)
        {
            if (stopped || callbacks.Count >= WorkLimits.PendingCallsMax)
            {
                throw new InvalidOperationException("Managed callback queue is closed or full.");
            }

            callbacks[id] = completion;
        }

        try
        {
            Write(new
            {
                kind = "callback",
                id,
                invocationId,
                operation,
                payload
            });
            var response = completion.Task.GetAwaiter().GetResult();

            if (response.Error is not null)
            {
                throw new InvalidOperationException(response.Error);
            }

            return response.Payload.Deserialize<ItemPayload>(Json)
                ?? throw new InvalidOperationException("Missing callback payload.");
        }
        finally
        {
            callbacks.TryRemove(id, out _);
        }
    }

    public void Complete(Invocation message)
    {
        if (!callbacks.TryGetValue(message.Id, out var completion))
        {
            throw new InvalidOperationException("Unknown callback response.");
        }

        completion.SetResult(message);
    }

    public void Stop()
    {
        lock (stateLock)
        {
            stopped = true;

            foreach (var completion in callbacks.Values)
            {
                completion.TrySetException(new EndOfStreamException("Bun connection closed."));
            }
        }
    }
}

public sealed record Remote(Protocol Protocol, string InvocationId, EventMetadata? EventData = null)
{
    public ItemPayload Call(string operation, object payload)
        => Protocol.Call(InvocationId, operation, payload);

    public void Unsupported(string capability)
    {
        Call("unsupported", new
        {
            capability
        });

        throw new NotSupportedException(capability);
    }
}
