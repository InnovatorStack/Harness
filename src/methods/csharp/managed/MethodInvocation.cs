using System.Reflection;

namespace InnovatorHarness.Managed;

internal static class MethodInvocation
{
    internal static void Run(Invocation message, MethodContext context,
        MethodAssemblies? shared, Protocol protocol)
    {
        try
        {
            Execute(message, context, shared, protocol);
        }
        catch (Exception exception)
        {
            Exception error = exception;

            if (exception is TargetInvocationException { InnerException: { } inner })
            {
                error = inner;
            }

            protocol.Write(new
            {
                kind = "failure",
                id = message.Id,
                reusable = context.CanReuse,
                error = error.ToString()
            });
        }
    }

    private static void Execute(Invocation message, MethodContext context,
        MethodAssemblies? shared, Protocol protocol)
    {
        if (message.Assembly is null || message.TypeName is null || message.Context is null)
        {
            throw new InvalidOperationException("Incomplete managed invocation.");
        }

        var assembly = shared?.Find(message.Assembly);

        if (assembly is null)
        {
            assembly = context.LoadMethod(message.Assembly);
        }

        var type = assembly.GetType(message.TypeName, throwOnError: true)
            ?? throw new InvalidOperationException("Compiled Method type is missing.");
        var remote = new Remote(protocol, message.Id);
        using var scope = RemoteContext.Enter(remote);
        var instance = Activator.CreateInstance(type, message.Context, remote);
        var method = instance as IArasMethod
            ?? throw new InvalidOperationException("Compiled Method has the wrong template.");
        protocol.Write(new { kind = "started", id = message.Id, reusable = context.CanReuse });
        var result = method.Execute();
        var original = method.ContextPayload;
        var returned = original;

        if (result is not null && !ReferenceEquals(result, method))
        {
            returned = result.Payload;
        }

        var contextIsResult = ReferenceEquals(returned, original);
        ItemPayload? changedContext = null;

        if (!contextIsResult)
        {
            changedContext = original;
        }

        protocol.Write(new
        {
            kind = "result",
            id = message.Id,
            payload = returned,
            reusable = context.CanReuse,
            contextIsResult,
            context = changedContext
        });
    }
}
