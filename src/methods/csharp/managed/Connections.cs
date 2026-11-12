using InnovatorHarness.Managed;

namespace Aras.IOM
{
    public interface IServerConnection
    {
    }
}

namespace Aras.Server.Core
{
    public sealed class IOMConnection : Aras.IOM.IServerConnection
    {
        internal Remote Remote { get; }
        public CallContext CCO { get; }

        public IOMConnection(Remote remote)
        {
            Remote = remote;
            CCO = new CallContext(remote);
        }
    }

    public sealed class InnovatorServerException(string message) : Exception(message)
    {
    }
}
