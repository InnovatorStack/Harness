using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Operations;

namespace InnovatorHarness.Style;

internal static class ManagedRecursion
{
    public static int Check(IReadOnlyList<SyntaxTree> trees)
    {
        string assemblies = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            ?? throw new InvalidOperationException(
                "The SDK did not expose its assembly references.");

        var references = assemblies.Split(Path.PathSeparator)
            .Select(path => MetadataReference.CreateFromFile(path));

        var usings = CSharpSyntaxTree.ParseText(
            "global using System; global using System.IO; global using System.Linq; "
            + "global using System.Collections.Generic; global using System.Threading; "
            + "global using System.Threading.Tasks;");

        var compilation = CSharpCompilation.Create(
            "HarnessStyle", trees.Append(usings), references);
        var graph = new Dictionary<ISymbol, HashSet<ISymbol>>(SymbolEqualityComparer.Default);
        var locations = new Dictionary<ISymbol, SyntaxNode>(SymbolEqualityComparer.Default);

        foreach (SyntaxTree tree in trees)
        {
            SemanticModel model = compilation.GetSemanticModel(tree);
            Collect(model, tree.GetRoot(), graph, locations);
        }

        int errors = 0;
        foreach (var (owner, node) in locations)
        {
            if (HasCycle(owner, graph))
            {
                var location = node.GetLocation().GetLineSpan();
                Console.Error.WriteLine($"{location.Path}:{location.StartLinePosition.Line + 1}: "
                    + "recursion: Recursive managed execution is forbidden. "
                    + "Use a bounded work stack.");
                errors += 1;
            }
        }

        return errors;
    }

    private static void Collect(
        SemanticModel model,
        SyntaxNode root,
        Dictionary<ISymbol, HashSet<ISymbol>> graph,
        Dictionary<ISymbol, SyntaxNode> locations)
    {
        foreach (SyntaxNode node in root.DescendantNodes())
        {
            ISymbol? owner = Owner(model, node);

            if (owner is null)
            {
                continue;
            }

            if (!graph.TryGetValue(owner, out var edges))
            {
                edges = new(SymbolEqualityComparer.Default);
                graph.Add(owner, edges);
                locations.Add(owner, OwnerNode(node));
            }

            ISymbol? target = null;

            if (node is InvocationExpressionSyntax call)
            {
                target = Target(model, call.Expression);
            }
            else if (node is ObjectCreationExpressionSyntax creation)
            {
                target = model.GetSymbolInfo(creation).Symbol;
            }
            else if (node is MemberAccessExpressionSyntax member
                && model.GetSymbolInfo(member).Symbol is IPropertySymbol property)
            {
                target = property.GetMethod;
            }

            if (target is IMethodSymbol method)
            {
                edges.Add(method.OriginalDefinition);
            }
        }
    }

    private static ISymbol? Target(SemanticModel model, ExpressionSyntax expression)
    {
        ISymbol? symbol = model.GetSymbolInfo(expression).Symbol;

        if (symbol is IMethodSymbol)
        {
            return symbol;
        }

        if (symbol is ILocalSymbol or IFieldSymbol)
        {
            SyntaxNode? declared = symbol.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax();

            if (declared is VariableDeclaratorSyntax { Initializer.Value: { } value }
                && model.GetOperation(value) is IAnonymousFunctionOperation lambda)
            {
                return lambda.Symbol;
            }
        }

        return null;
    }

    private static SyntaxNode OwnerNode(SyntaxNode node)
    {
        foreach (SyntaxNode parent in node.AncestorsAndSelf())
        {
            if (parent is BaseMethodDeclarationSyntax or LocalFunctionStatementSyntax
                or AccessorDeclarationSyntax or AnonymousFunctionExpressionSyntax)
            {
                return parent;
            }
        }

        return node;
    }

    private static ISymbol? Owner(SemanticModel model, SyntaxNode node)
    {
        SyntaxNode owner = OwnerNode(node);

        if (owner is AnonymousFunctionExpressionSyntax
            && model.GetOperation(owner) is IAnonymousFunctionOperation lambda)
        {
            return lambda.Symbol.OriginalDefinition;
        }

        return model.GetDeclaredSymbol(owner)?.OriginalDefinition;
    }

    private static bool HasCycle(ISymbol origin, Dictionary<ISymbol, HashSet<ISymbol>> graph)
    {
        if (!graph.TryGetValue(origin, out var first))
        {
            return false;
        }

        var pending = new Stack<ISymbol>(first);
        var visited = new HashSet<ISymbol>(SymbolEqualityComparer.Default);

        while (pending.Count > 0)
        {
            ISymbol current = pending.Pop();

            if (SymbolEqualityComparer.Default.Equals(current, origin))
            {
                return true;
            }

            if (!visited.Add(current))
            {
                continue;
            }

            if (graph.TryGetValue(current, out var next))
            {
                foreach (ISymbol target in next)
                {
                    pending.Push(target);
                }
            }
        }

        return false;
    }
}
