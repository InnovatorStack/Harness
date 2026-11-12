import { relative, resolve } from "node:path";

import * as syntax from "typescript/unstable/ast";

import { checkLayout, formatLayout } from "./layout.js";
import { withProject } from "./project.js";
import { checkRecursion } from "./recursion.js";

export interface StyleDiagnostic {
    readonly file: string;
    readonly line: number;
    readonly rule: string;
    readonly message: string;
}

const functionLinesMax = 70;
const lineColumnsMax = 100;

export async function checkTypeScriptStyle(directory: string): Promise<readonly StyleDiagnostic[]> {
    return await withProject(directory, async (project) => {
        const diagnostics: StyleDiagnostic[] = [];
        const sources: syntax.SourceFile[] = [];

        if (project.rootFiles.length === 0) {
            throw new Error("The style checker found no project files.");
        }

        await assertProjectCoverage(directory, project.rootFiles);
        const syntaxErrors = await project.program.getSyntacticDiagnostics();

        if (syntaxErrors.length > 0) {
            throw new Error("Cannot check style while project files contain syntax errors.");
        }

        for (const path of project.rootFiles) {
            const source = await project.program.getSourceFile(path);

            if (!source) {
                throw new Error(`The style checker could not parse '${path}'.`);
            }

            sources.push(source);
            diagnostics.push(...checkSourceStyle(source, directory));
        }

        diagnostics.push(...(await checkRecursion(project, sources, directory)));

        return diagnostics;
    });
}

export async function formatTypeScriptLayout(directory: string): Promise<void> {
    await withProject(directory, async (project) => {
        for (const path of project.rootFiles) {
            const source = await project.program.getSourceFile(path);

            if (!source) {
                throw new Error(`Cannot inspect layout for '${path}'.`);
            }

            const formatted = formatLayout(source);

            if (formatted !== source.text) {
                await Bun.write(path, formatted);
            }
        }
    });
}

export function checkSourceStyle(
    source: syntax.SourceFile,
    directory: string,
): readonly StyleDiagnostic[] {
    const diagnostics: StyleDiagnostic[] = [];
    const literals: syntax.Node[] = [];
    const pending: syntax.Node[] = [source];

    while (pending.length > 0) {
        const node = pending.pop();

        if (!node) {
            throw new Error("A syntax node must exist while the traversal stack is nonempty.");
        }

        const body = functionBody(node);

        if (isDataLiteral(node)) {
            literals.push(node);
        }

        const assertion = typeAssertionDiagnostic(node, source, directory);

        if (assertion) {
            diagnostics.push(assertion);
        }

        if (body && !isTestGroup(node)) {
            const first = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
            const last = source.getLineAndCharacterOfPosition(node.end).line;
            const lines = last - first + 1;

            if (lines > functionLinesMax) {
                diagnostics.push({
                    file: relative(directory, source.fileName),
                    line: first + 1,
                    rule: "function-length",
                    message: `Function has ${lines} lines; the maximum is ${functionLinesMax}.`,
                });
            }
        }

        node.forEachChild((child) => {
            pending.push(child);
        });
    }

    diagnostics.push(
        ...checkLineWidths(source, directory, literals),
        ...checkLayout(source, relative(directory, source.fileName)),
    );

    return diagnostics;
}

function typeAssertionDiagnostic(
    node: syntax.Node,
    source: syntax.SourceFile,
    directory: string,
): StyleDiagnostic | undefined {
    if (!syntax.isAssertionExpression(node)) {
        return undefined;
    }

    const type = node.type;

    if (
        syntax.isTypeReferenceNode(type) &&
        syntax.isIdentifier(type.typeName) &&
        type.typeName.text === "const"
    ) {
        return undefined;
    }

    return {
        file: relative(directory, source.fileName),
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        rule: "type-assertion",
        message: "Narrow the value or use satisfies instead of a type assertion.",
    };
}

function isDataLiteral(node: syntax.Node): boolean {
    return (
        syntax.isStringLiteral(node) ||
        syntax.isNoSubstitutionTemplateLiteral(node) ||
        syntax.isTemplateHead(node) ||
        syntax.isTemplateMiddle(node) ||
        syntax.isTemplateTail(node) ||
        syntax.isRegularExpressionLiteral(node)
    );
}

function checkLineWidths(
    source: syntax.SourceFile,
    directory: string,
    literals: readonly syntax.Node[],
): readonly StyleDiagnostic[] {
    const diagnostics: StyleDiagnostic[] = [];
    let offset = 0;
    const ranges = literals.map((node) => ({ start: node.getStart(source), end: node.end }));
    const lines = source.text.split("\n");

    for (const [index, line] of lines.entries()) {
        if (line.length > lineColumnsMax) {
            // Embedded AML, original Method source and literal values must retain their contents.
            // Count the surrounding code so a long data token cannot conceal a dense expression.
            let columns = line.length;

            for (const range of ranges) {
                const start = Math.max(offset, range.start);
                const end = Math.min(offset + line.length, range.end);

                if (start < end) {
                    columns -= end - start;
                    columns += 2;
                }
            }

            if (columns > lineColumnsMax) {
                diagnostics.push({
                    file: relative(directory, source.fileName),
                    line: index + 1,
                    rule: "line-width",
                    message: `Code has ${columns} columns; the maximum is ${lineColumnsMax}.`,
                });
            }
        }

        offset += line.length + 1;
    }

    return diagnostics;
}

function functionBody(node: syntax.Node): syntax.ConciseBody | undefined {
    if (syntax.isFunctionDeclaration(node)) {
        return node.body;
    }

    if (syntax.isFunctionExpression(node)) {
        return node.body;
    }

    if (syntax.isArrowFunction(node)) {
        return node.body;
    }

    if (syntax.isMethodDeclaration(node)) {
        return node.body;
    }

    if (syntax.isConstructorDeclaration(node)) {
        return node.body;
    }

    if (syntax.isGetAccessorDeclaration(node)) {
        return node.body;
    }

    if (syntax.isSetAccessorDeclaration(node)) {
        return node.body;
    }

    return undefined;
}

function isTestGroup(node: syntax.Node): boolean {
    if (!syntax.isArrowFunction(node)) {
        return false;
    }

    const parent = node.parent;

    if (!syntax.isCallExpression(parent)) {
        return false;
    }

    if (!syntax.isIdentifier(parent.expression)) {
        return false;
    }

    const called = parent.expression.text;

    return node.getSourceFile().statements.some((statement) => {
        if (!syntax.isImportDeclaration(statement)) {
            return false;
        }

        if (
            !syntax.isStringLiteral(statement.moduleSpecifier) ||
            statement.moduleSpecifier.text !== "bun:test"
        ) {
            return false;
        }

        const bindings = statement.importClause?.namedBindings;

        if (!bindings || !syntax.isNamedImports(bindings)) {
            return false;
        }

        return bindings.elements.some(
            (binding) =>
                binding.name.text === called &&
                (binding.propertyName?.text ?? called) === "describe",
        );
    });
}

async function assertProjectCoverage(directory: string, inputs: readonly string[]): Promise<void> {
    const included = new Set(inputs.map((path) => resolve(directory, path)));
    const extension = "*.{ts,tsx,mts,cts}";
    const patterns = [
        extension,
        ...["src", "tests", "scripts", ".harness"].map((path) => `${path}/**/${extension}`),
    ];

    for (const pattern of patterns) {
        for await (const path of new Bun.Glob(pattern).scan({ cwd: directory, dot: true })) {
            if (path.startsWith("tests/results/") || path.startsWith(".harness/local/")) {
                continue;
            }

            if (!included.has(resolve(directory, path))) {
                throw new Error(
                    `${path} is missing from tsconfig.json; style coverage must be explicit.`,
                );
            }
        }
    }
}
