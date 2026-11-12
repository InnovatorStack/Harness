namespace InnovatorHarness.Managed;

public sealed class CallContext(Remote remote)
{
    public DatabaseContext DB { get; } = new();
    public ErrorLookup ErrorLookup { get; } = new(remote);
    public Permissions Permissions { get; } = new(remote);
}

public sealed class DatabaseContext
{
    public SqlLiterals InnDatabase { get; } = new();
}

public sealed class SqlLiterals
{
    public string QuoteValue(string value)
    {
        return value.Replace("'", "''");
    }
}
