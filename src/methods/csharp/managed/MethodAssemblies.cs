using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;

namespace InnovatorHarness.Managed;

/// <summary>Keep JIT code only when the assembly has no world-owned static storage.</summary>
internal sealed class MethodAssemblies(IReadOnlyDictionary<string, string> references)
{
    private const int AssembliesMax = 2048;
    private readonly MethodContext context = new(references);
    private readonly Dictionary<string, Assembly?> assemblies = new(StringComparer.Ordinal);
    private readonly object gate = new();

    internal Assembly? Find(string path)
    {
        lock (gate)
        {
            if (assemblies.TryGetValue(path, out var cached))
            {
                return cached;
            }

            if (assemblies.Count >= AssembliesMax)
            {
                return null;
            }

            Assembly? assembly = null;

            if (CanShare(path))
            {
                assembly = context.LoadMethod(path);
            }

            assemblies.Add(path, assembly);

            return assembly;
        }
    }

    private static bool CanShare(string path)
    {
        if (!ContextSafety.CanReuse(path))
        {
            return false;
        }

        using var stream = File.OpenRead(path);
        using var image = new PEReader(stream);
        var metadata = image.GetMetadataReader();

        foreach (var handle in metadata.FieldDefinitions)
        {
            var field = metadata.GetFieldDefinition(handle);
            var attributes = field.Attributes;

            if ((attributes & FieldAttributes.Static) != 0 &&
                !IsCodeConstant(metadata, field))
            {
                return false;
            }
        }

        return true;
    }

    private static bool IsCodeConstant(MetadataReader metadata, FieldDefinition field)
    {
        if ((field.Attributes & FieldAttributes.Literal) != 0)
        {
            return true;
        }

        // Roslyn embeds array initializer bytes here; InitializeArray copies them into new arrays.
        var immutableData = FieldAttributes.InitOnly | FieldAttributes.HasFieldRVA;
        var owner = metadata.GetTypeDefinition(field.GetDeclaringType());

        return (field.Attributes & immutableData) == immutableData &&
            field.GetRelativeVirtualAddress() != 0 &&
            metadata.GetString(owner.Name) == "<PrivateImplementationDetails>";
    }
}
