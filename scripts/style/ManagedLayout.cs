using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace InnovatorHarness.Style;

internal static class ManagedLayout
{
    public static int Check(SyntaxTree tree)
    {
        int errors = 0;

        foreach (int position in Gaps(tree))
        {
            int line = tree.GetText().Lines.GetLineFromPosition(position).LineNumber + 1;
            Console.Error.WriteLine($"{tree.FilePath}:{line}: logical-spacing: "
                + "Separate control-flow phases and method declarations with a blank line.");
            errors += 1;
        }

        return errors;
    }

    public static string Format(SyntaxTree tree)
    {
        string text = tree.GetText().ToString();

        foreach (int position in Gaps(tree).OrderDescending())
        {
            string spacing = "\n\n";

            if (position > 0 && text[position - 1] == '\n')
            {
                spacing = "\n";
            }

            text = text.Insert(position, spacing);
        }

        return text;
    }

    private static HashSet<int> Gaps(SyntaxTree tree)
    {
        string text = tree.GetText().ToString();
        var gaps = new HashSet<int>();

        foreach (SyntaxNode node in tree.GetRoot().DescendantNodesAndSelf())
        {
            SyntaxNode[] siblings = Children(node);

            for (int index = 1; index < siblings.Length; index += 1)
            {
                SyntaxNode previous = siblings[index - 1];
                SyntaxNode current = siblings[index];

                if (!Boundary(previous) && !Boundary(current)
                    && current is not ReturnStatementSyntax and not ThrowStatementSyntax)
                {
                    continue;
                }

                string gap = text[previous.Span.End..current.SpanStart];

                if (!System.Text.RegularExpressions.Regex.IsMatch(gap, "\\n[\\t ]*\\r?\\n"))
                {
                    int newline = gap.IndexOf('\n');
                    gaps.Add(previous.Span.End + Math.Max(0, newline + 1));
                }
            }
        }

        return gaps;
    }

    private static SyntaxNode[] Children(SyntaxNode node)
    {
        return node switch
        {
            BlockSyntax block => block.Statements.ToArray(),
            SwitchSectionSyntax section => section.Statements.ToArray(),
            TypeDeclarationSyntax type => type.Members.ToArray(),
            _ => Array.Empty<SyntaxNode>()
        };
    }

    private static bool Boundary(SyntaxNode node)
    {
        return node is IfStatementSyntax or ForStatementSyntax or ForEachStatementSyntax
            or WhileStatementSyntax or DoStatementSyntax or TryStatementSyntax
            or SwitchStatementSyntax or UsingStatementSyntax or LockStatementSyntax
            or BaseMethodDeclarationSyntax or LocalFunctionStatementSyntax;
    }
}
