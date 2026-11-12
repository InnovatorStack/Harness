using Aras.Server.Security;

namespace InnovatorHarness.Managed;

public sealed class Permissions(Remote remote)
{
    public string IdentitiesList
    {
        get
        {
            return remote.Call("securityIdentities", new { }).Result
                ?? throw new InvalidOperationException("The session identity list is missing.");
        }
    }

    public bool IdentityListHasId(string identities, string id)
    {
        return identities.Split(',',
            StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
            .Any(identity => identity.Equals(id, StringComparison.OrdinalIgnoreCase));
    }

    public IDisposable GrantIdentity(Identity? identity)
    {
        ArgumentNullException.ThrowIfNull(identity);
        string token = remote.Call("securityGrant", new { id = identity.Id }).Result
            ?? throw new InvalidOperationException("The granted identity scope has no token.");

        return new Grant(remote, token);
    }

    private sealed class Grant(Remote remote, string token) : IDisposable
    {
        private bool disposed;

        public void Dispose()
        {
            if (disposed)
            {
                return;
            }

            remote.Call("securityRevoke", new { token });
            disposed = true;
        }
    }
}
