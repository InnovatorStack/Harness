using System.Reflection;
using System.Runtime.Loader;

namespace InnovatorHarness.Managed;

internal sealed class MethodContext(IReadOnlyDictionary<string, string> references)
    : AssemblyLoadContext(isCollectible: true)
{
    private int reusable = 1;

    internal bool CanReuse => Volatile.Read(ref reusable) == 1;

    internal Assembly LoadMethod(string path)
    {
        if (!ContextSafety.CanReuse(path))
        {
            Interlocked.Exchange(ref reusable, 0);
        }

        return LoadFromAssemblyPath(path);
    }

    protected override Assembly? Load(AssemblyName name)
    {
        var contract = typeof(IArasMethod).Assembly;

        if (name.Name == contract.GetName().Name)
        {
            return contract;
        }

        if (name.Name == "Newtonsoft.Json")
        {
            return Default.LoadFromAssemblyName(name);
        }

        if (name.Name is not null && references.TryGetValue(name.Name, out var path))
        {
            return LoadFromAssemblyPath(path);
        }

        return null;
    }
}
