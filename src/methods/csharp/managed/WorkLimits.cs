namespace InnovatorHarness.Managed;

internal static class WorkLimits
{
    // Match the transport/data budgets in the Bun owner. Contract tests check these values.
    public const int DepthMax = 256;
    public const int NodesMax = 1_000_000;
    public const int DataBytesMax = 64 * 1024 * 1024;
    public const int MessageBytesMax = 8 * 1024 * 1024;
    public const int PendingCallsMax = 128;
}
