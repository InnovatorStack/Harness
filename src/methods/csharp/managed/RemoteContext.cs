namespace InnovatorHarness.Managed;

internal static class RemoteContext
{
    private static readonly AsyncLocal<Remote?> current = new();

    internal static Remote Current => current.Value
        ?? throw new InvalidOperationException("Native APIs require an active Method invocation.");

    internal static IDisposable Enter(Remote remote)
    {
        var previous = current.Value;
        current.Value = remote;

        return new Scope(previous);
    }

    private sealed class Scope(Remote? previous) : IDisposable
    {
        private bool disposed;

        public void Dispose()
        {
            if (disposed)
            {
                return;
            }

            disposed = true;
            current.Value = previous;
        }
    }
}
