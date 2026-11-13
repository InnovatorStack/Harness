using System.Reflection;
using System.Text.Json;
using System.Xml;

namespace InnovatorHarness.Managed;

internal static class MethodInvocation
{
    private const int FailureTextMax = 16 * 1024;

    internal static void Run(Invocation message, MethodContext context,
        MethodAssemblies? shared, Protocol protocol)
    {
        var remote = new Remote(protocol, message.Id, message.EventData);

        try
        {
            using var scope = RemoteContext.Enter(remote);
            Execute(message, context, shared, protocol, remote);
        }
        catch (Exception exception)
        {
            Exception error = exception;

            if (exception is TargetInvocationException { InnerException: { } inner })
            {
                error = inner;
            }

            WriteFailure(message, context, protocol, remote, error);
        }
    }

    private static void WriteFailure(
        Invocation message, MethodContext context, Protocol protocol, Remote remote,
        Exception error)
    {
        string failure = FailureText(error);

        try
        {
            OriginFrame? origins = null;

            if (message.Context is { } input)
            {
                origins = remote.Origins.Capture(input);
            }

            protocol.Write(new
            {
                kind = "failure",
                id = message.Id,
                reusable = context.CanReuse,
                error = failure,
                context = message.Context,
                contextOrigins = origins
            });
        }
        catch (Exception contextError) when (contextError is NotSupportedException
            or InvalidOperationException or JsonException or ArgumentException or XmlException)
        {
            protocol.Write(new
            {
                kind = "failure",
                id = message.Id,
                reusable = context.CanReuse,
                error = failure,
                contextError = FailureText(contextError)
            });
        }
    }

    private static string FailureText(Exception error)
    {
        string text = error.ToString();

        if (text.Length > FailureTextMax)
        {
            return text[..FailureTextMax] + " [truncated]";
        }

        return text;
    }

    private static void Execute(Invocation message, MethodContext context,
        MethodAssemblies? shared, Protocol protocol, Remote remote)
    {
        if (message.Assembly is null || message.TypeName is null || message.Context is null)
        {
            throw new InvalidOperationException("Incomplete managed invocation.");
        }

        remote.Origins.Apply(message.Context, message.ContextOrigins);
        var assembly = shared?.Find(message.Assembly);

        if (assembly is null)
        {
            assembly = context.LoadMethod(message.Assembly);
        }

        var type = assembly.GetType(message.TypeName, throwOnError: true)
            ?? throw new InvalidOperationException("Compiled Method type is missing.");
        var instance = Activator.CreateInstance(type, message.Context, remote);
        var method = instance as IArasMethod
            ?? throw new InvalidOperationException("Compiled Method has the wrong template.");
        protocol.Write(new { kind = "started", id = message.Id, reusable = context.CanReuse });
        var result = method.Execute();
        var original = method.ContextPayload;
        var returned = new ItemPayload { Result = "" };

        if (result is not null)
        {
            returned = result.Payload;
        }

        var contextIsResult = ReferenceEquals(returned, original);
        ItemPayload? changedContext = null;
        OriginFrame? changedOrigins = null;

        if (!contextIsResult)
        {
            changedContext = original;
            changedOrigins = remote.Origins.Capture(original);
        }

        protocol.Write(new
        {
            kind = "result",
            id = message.Id,
            payload = returned,
            reusable = context.CanReuse,
            contextIsResult,
            context = changedContext,
            origins = remote.Origins.Capture(returned),
            contextOrigins = changedOrigins
        });
    }
}
