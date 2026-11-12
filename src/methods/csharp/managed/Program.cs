using System.Reflection;
using System.Runtime.Loader;
using System.Text.Json;
using InnovatorHarness.Managed;

var protocol = new Protocol(Console.Out);
using var input = new ProtocolInput(Console.OpenStandardInput());
Console.SetOut(Console.Error);
var references = args.ToDictionary(
    path => AssemblyName.GetAssemblyName(path).Name
        ?? throw new InvalidOperationException("Reference assembly has no name."),
    Path.GetFullPath,
    StringComparer.OrdinalIgnoreCase);

if (!references.ContainsKey("Newtonsoft.Json"))
{
    references.Add("Newtonsoft.Json",
        Path.Combine(AppContext.BaseDirectory, "Newtonsoft.Json.dll"));
}

AssemblyLoadContext.Default.Resolving += (_, name) =>
{
    if (name.Name is not null && references.TryGetValue(name.Name, out var path))
    {
        return AssemblyLoadContext.Default.LoadFromAssemblyPath(path);
    }

    return null;
};
var tasks = new List<Task>();
MethodAssemblies? sharedMethods = null;

if (args.Length == 0)
{
    sharedMethods = new MethodAssemblies(references);
}

var methodContext = new MethodContext(references);

try
{
    while (input.ReadLine() is { } line)
    {
        var message = JsonSerializer.Deserialize<Invocation>(line, Protocol.Json)
            ?? throw new InvalidOperationException("Invalid Bun message.");

        if (message.Kind == "callbackResult")
        {
            protocol.Complete(message);
        }
        else if (message.Kind == "reset")
        {
            // Keep the blocking input loop on its dedicated main thread after a reset.
            Task.WhenAll(tasks).GetAwaiter().GetResult();
            tasks.Clear();
            methodContext.Unload();
            methodContext = new MethodContext(references);
            protocol.Write(new { kind = "reset", id = message.Id });
        }
        else if (message.Kind == "invoke")
        {
            protocol.Write(new { kind = "received", id = message.Id });
            tasks.RemoveAll(task => task.IsCompleted);

            if (tasks.Count >= WorkLimits.PendingCallsMax)
            {
                throw new InvalidOperationException("Managed invocation queue is full.");
            }

            tasks.Add(Task.Run(() => MethodInvocation.Run(
                message, methodContext, sharedMethods, protocol)));
        }
        else
        {
            throw new InvalidOperationException($"Unknown message kind '{message.Kind}'.");
        }
    }
}
finally
{
    protocol.Stop();
    Task.WhenAll(tasks).GetAwaiter().GetResult();
}
