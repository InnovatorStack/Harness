using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;

namespace InnovatorHarness.Managed;

internal static class ContextSafety
{
    private static readonly HashSet<string> ValueTypes = new(StringComparer.Ordinal)
    {
        "Object", "String", "Boolean", "Byte", "SByte", "Char", "Int16", "UInt16",
        "Int32", "UInt32", "Int64", "UInt64", "Single", "Double", "Decimal", "IntPtr",
        "UIntPtr", "Void", "Math", "MathF", "Convert", "DateTime", "DateTimeOffset",
        "TimeSpan", "Guid", "Array", "Enum", "StringComparer", "StringComparison",
        "StringSplitOptions", "MidpointRounding", "DayOfWeek", "DateTimeKind", "TypeCode",
        "Index", "Range", "BitConverter", "Buffer", "FormattableString", "IDisposable"
    };

    private static readonly HashSet<string> CompilerAttributes = new(StringComparer.Ordinal)
    {
        "CompilationRelaxationsAttribute", "RuntimeCompatibilityAttribute", "NullableAttribute",
        "NullableContextAttribute", "CompilerGeneratedAttribute", "RefSafetyRulesAttribute",
        "ExtensionAttribute", "IsReadOnlyAttribute", "TargetFrameworkAttribute",
        "DebuggableAttribute", "AssemblyCompanyAttribute", "AssemblyConfigurationAttribute",
        "AssemblyFileVersionAttribute", "AssemblyInformationalVersionAttribute",
        "AssemblyProductAttribute", "AssemblyTitleAttribute",
        "AssemblyVersionAttribute", "DebuggerDisplayAttribute", "DebuggerBrowsableAttribute",
        "DebuggerHiddenAttribute", "IteratorStateMachineAttribute", "TupleElementNamesAttribute",
        "ParamArrayAttribute"
    };

    internal static bool CanReuse(string path)
    {
        using var stream = File.OpenRead(path);
        using var image = new PEReader(stream);
        var metadata = image.GetMetadataReader();

        if (metadata.MemberReferences.Count > WorkLimits.NodesMax)
        {
            return false;
        }

        foreach (var handle in metadata.MethodDefinitions)
        {
            var attributes = metadata.GetMethodDefinition(handle).Attributes;

            if ((attributes & MethodAttributes.PinvokeImpl) != 0)
            {
                return false;
            }
        }

        foreach (var handle in metadata.MemberReferences)
        {
            var member = metadata.GetMemberReference(handle);
            var type = ReferencedType(metadata, member.Parent);

            if (type is null || !Allowed(type.Value.Namespace, type.Value.Name,
                    metadata.GetString(member.Name)))
            {
                return false;
            }
        }

        return true;
    }

    private static (string Namespace, string Name)? ReferencedType(
        MetadataReader metadata, EntityHandle handle)
    {
        if (handle.Kind == HandleKind.TypeSpecification)
        {
            var specification = metadata.GetTypeSpecification((TypeSpecificationHandle)handle);
            var signature = metadata.GetBlobReader(specification.Signature);

            // Generic instance, followed by class/value-type and a TypeDefOrRef coded index.
            if (signature.RemainingBytes < 3 || signature.ReadByte() != 0x15)
            {
                return null;
            }

            var kind = signature.ReadByte();

            if (kind != 0x11 && kind != 0x12)
            {
                return null;
            }

            var index = signature.ReadCompressedInteger();

            if ((index & 3) == 0)
            {
                return ("InnovatorHarness.Generated", "OwnedMethod");
            }

            if ((index & 3) != 1)
            {
                return null;
            }

            handle = MetadataTokens.TypeReferenceHandle(index >> 2);
        }

        if (handle.Kind == HandleKind.TypeDefinition)
        {
            return ("InnovatorHarness.Generated", "OwnedMethod");
        }

        if (handle.Kind != HandleKind.TypeReference)
        {
            return null;
        }

        return ReferencedName(metadata, (TypeReferenceHandle)handle);
    }

    private static (string Namespace, string Name)? ReferencedName(
        MetadataReader metadata, TypeReferenceHandle handle)
    {
        var type = metadata.GetTypeReference(handle);
        var name = metadata.GetString(type.Name);
        var space = metadata.GetString(type.Namespace);
        var parent = type.ResolutionScope;
        var depth = 0;

        while (space.Length == 0 && parent.Kind == HandleKind.TypeReference)
        {
            if (++depth > WorkLimits.DepthMax)
            {
                return null;
            }

            type = metadata.GetTypeReference((TypeReferenceHandle)parent);
            space = metadata.GetString(type.Namespace);
            parent = type.ResolutionScope;
        }

        return (space, name);
    }

    private static bool Allowed(string space, string type, string member)
    {
        if (space == "Newtonsoft.Json" && type == "JsonConvert" && member == "set_DefaultSettings")
        {
            return false;
        }

        if ((space == "System" || space.StartsWith("System.", StringComparison.Ordinal)) &&
            member == ".ctor" && CompilerAttributes.Contains(type))
        {
            return true;
        }

        if (space.StartsWith("InnovatorHarness.", StringComparison.Ordinal) ||
            space.StartsWith("Aras.", StringComparison.Ordinal) ||
            space.StartsWith("Newtonsoft.Json", StringComparison.Ordinal) ||
            space.StartsWith("System.Collections", StringComparison.Ordinal) ||
            space.StartsWith("System.Linq", StringComparison.Ordinal) ||
            space.StartsWith("System.Xml", StringComparison.Ordinal) ||
            space.StartsWith("System.Text.Json", StringComparison.Ordinal))
        {
            return true;
        }

        if (space == "System.Runtime.CompilerServices")
        {
            return type == "DefaultInterpolatedStringHandler" ||
                (type == "RuntimeHelpers" && member == "InitializeArray");
        }

        if (space == "System.Text" && type == "StringBuilder")
        {
            return true;
        }

        if (space == "System.Globalization" && type == "CultureInfo")
        {
            return member == "get_InvariantCulture" || member == "get_CurrentCulture" ||
                member == "GetCultureInfo" || member == ".ctor";
        }

        if (space == "System.Text.RegularExpressions" && type == "Regex")
        {
            return member == "IsMatch" || member == "Match" || member == "Matches" ||
                member == "Replace" || member == "Split" || member == "Escape" ||
                member == "Unescape" || member == ".ctor";
        }

        return SystemValueMember(space, type, member);
    }

    private static bool SystemValueMember(string space, string type, string member)
    {
        if (space != "System" || member == "GetType")
        {
            return false;
        }

        if (type == "Console")
        {
            return member == "Write" || member == "WriteLine";
        }

        if (type == "Environment")
        {
            return member == "get_CurrentManagedThreadId";
        }

        return ValueTypes.Contains(type) || type.EndsWith("Exception", StringComparison.Ordinal) ||
            type.StartsWith("Func`", StringComparison.Ordinal) ||
            type.StartsWith("Action`", StringComparison.Ordinal) ||
            type.StartsWith("Tuple`", StringComparison.Ordinal) ||
            type.StartsWith("ValueTuple`", StringComparison.Ordinal) ||
            type.StartsWith("Nullable`", StringComparison.Ordinal) ||
            type.StartsWith("Span`", StringComparison.Ordinal) ||
            type.StartsWith("ReadOnlySpan`", StringComparison.Ordinal);
    }
}
