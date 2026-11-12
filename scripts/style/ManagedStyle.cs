using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace InnovatorHarness.Style;

internal static class ManagedStyle
{
    private const int FunctionLinesMax = 70;
    private const int LineColumnsMax = 100;

    public static int Main(string[] paths)
    {
        int errors = 0;
        var trees = new List<SyntaxTree>();
        bool layoutOnly = paths.Contains("--format-layout");

        foreach (string path in paths.Where(path => path != "--format-layout"))
        {
            string text = File.ReadAllText(path);

            if (!path.EndsWith(".cs", StringComparison.Ordinal)
                && !path.EndsWith(".cs.template", StringComparison.Ordinal))
            {
                errors += CheckText(path, text);
                continue;
            }

            if (path.EndsWith(".cs.template", StringComparison.Ordinal))
            {
                text = text.Replace("__SOURCE_LINE__", "1")
                    .Replace("__SOURCE_PATH__", "Method.cs")
                    .Replace("__METHOD_CODE__", "        return this;");
            }

            SyntaxTree tree = CSharpSyntaxTree.ParseText(text, path: path);

            if (layoutOnly)
            {
                if (path.EndsWith(".cs", StringComparison.Ordinal))
                {
                    File.WriteAllText(path, ManagedLayout.Format(tree));
                }

                continue;
            }

            trees.Add(tree);
            errors += ManagedLayout.Check(tree);

            foreach (Diagnostic diagnostic in tree.GetDiagnostics())
            {
                if (diagnostic.Severity == DiagnosticSeverity.Error)
                {
                    errors += Report(tree.GetRoot(), "syntax", diagnostic.GetMessage());
                }
            }

            errors += CheckText(path, text);

            foreach (SyntaxNode node in tree.GetRoot().DescendantNodes())
            {
                errors += CheckNode(node);
            }
        }

        if (!layoutOnly)
        {
            errors += ManagedRecursion.Check(trees);
        }

        return Math.Min(errors, 1);
    }

    private static int CheckText(string path, string text)
    {
        int errors = 0;

        foreach (var line in SourceText.From(text).Lines)
        {
            if (line.Span.Length > LineColumnsMax)
            {
                errors += Report(path, line.LineNumber + 1, "line-width",
                    $"Line has {line.Span.Length} columns; the maximum is {LineColumnsMax}.");
            }

            string content = line.ToString();
            int indent = 0;

            while (indent < content.Length && content[indent] == ' ')
            {
                indent += 1;
            }

            if (indent % 4 != 0 || (indent < content.Length && content[indent] == '\t'))
            {
                errors += Report(path, line.LineNumber + 1, "indentation",
                    "Use multiples of four spaces for indentation.");
            }
        }

        return errors;
    }

    private static int CheckNode(SyntaxNode node)
    {
        if (node is ConditionalExpressionSyntax)
        {
            return Report(node, "explicit-branches",
                "Use if/else instead of a ternary expression.");
        }

        if (node is IfStatementSyntax branch && branch.Statement is not BlockSyntax)
        {
            return Report(node, "explicit-blocks", "Use braces around the branch body.");
        }

        StatementSyntax? body = node switch
        {
            ForStatementSyntax loop => loop.Statement,
            ForEachStatementSyntax loop => loop.Statement,
            WhileStatementSyntax loop => loop.Statement,
            DoStatementSyntax loop => loop.Statement,
            LockStatementSyntax statement => statement.Statement,
            UsingStatementSyntax statement => statement.Statement,
            _ => null
        };

        if (body is not null && body is not BlockSyntax)
        {
            return Report(node, "explicit-blocks", "Use braces around the statement body.");
        }

        if (node is BaseMethodDeclarationSyntax or LocalFunctionStatementSyntax
            or AnonymousFunctionExpressionSyntax or AccessorDeclarationSyntax)
        {
            var lines = node.GetLocation().GetLineSpan();
            int count = lines.EndLinePosition.Line - lines.StartLinePosition.Line + 1;

            if (count > FunctionLinesMax)
            {
                return Report(node, "function-length",
                    $"Function has {count} lines; the maximum is {FunctionLinesMax}.");
            }
        }

        return 0;
    }

    private static int Report(SyntaxNode node, string rule, string message)
    {
        var location = node.GetLocation().GetLineSpan();

        return Report(location.Path, location.StartLinePosition.Line + 1, rule, message);
    }

    private static int Report(string path, int line, string rule, string message)
    {
        Console.Error.WriteLine($"{path}:{line}: {rule}: {message}");

        return 1;
    }
}
