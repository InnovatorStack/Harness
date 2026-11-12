import * as syntax from "typescript/unstable/ast";

import type { StyleDiagnostic } from "./typescript.js";

/** Separate control-flow phases instead of using the line limit to justify compressed code. */
export function layoutGaps(source: syntax.SourceFile): readonly number[] {
    const gaps = new Set<number>();
    const pending: syntax.Node[] = [source];

    while (pending.length > 0) {
        const node = pending.pop();

        if (!node) {
            throw new Error("A syntax node must exist while layout inspection is pending.");
        }

        for (const position of inlineObjectGaps(node, source)) {
            gaps.add(position);
        }

        const siblings = siblingStatements(node);

        for (let index = 1; index < siblings.length; index += 1) {
            const previous = siblings[index - 1];
            const current = siblings[index];

            if (!previous || !current || !needsSpace(previous, current)) {
                continue;
            }

            const gap = source.text.slice(previous.end, current.getStart(source));

            if (!/\n[\t ]*\r?\n/u.test(gap)) {
                const newline = gap.indexOf("\n");
                gaps.add(newline !== -1 ? previous.end + newline + 1 : current.getStart(source));
            }
        }

        node.forEachChild((child) => {
            pending.push(child);
        });
    }

    return [...gaps].sort((left, right) => right - left);
}

function inlineObjectGaps(node: syntax.Node, source: syntax.SourceFile): readonly number[] {
    if (
        !syntax.isObjectLiteralExpression(node) ||
        node.properties.length < 2 ||
        !node.properties.some(isBoundary)
    ) {
        return [];
    }

    const first = node.properties[0];

    if (!first || source.text.slice(node.getStart(source), first.getStart(source)).includes("\n")) {
        return [];
    }

    return [node.getStart(source) + 1, node.end - 1];
}

export function checkLayout(source: syntax.SourceFile, file: string): readonly StyleDiagnostic[] {
    return layoutGaps(source).map((position) => ({
        file,
        line: source.getLineAndCharacterOfPosition(position).line + 1,
        rule: "logical-spacing",
        message: "Separate control-flow blocks, declarations and final results with a blank line.",
    }));
}

export function formatLayout(source: syntax.SourceFile): string {
    let text = source.text;

    for (const position of layoutGaps(source)) {
        const spacing = source.text[position - 1] === "\n" ? "\n" : "\n\n";
        text = `${text.slice(0, position)}${spacing}${text.slice(position)}`;
    }

    return text;
}

function siblingStatements(node: syntax.Node): readonly syntax.Node[] {
    if (syntax.isSourceFile(node) || syntax.isBlock(node) || syntax.isModuleBlock(node)) {
        return node.statements;
    }

    if (syntax.isCaseClause(node) || syntax.isDefaultClause(node)) {
        return node.statements;
    }

    if (syntax.isClassDeclaration(node) || syntax.isClassExpression(node)) {
        return node.members;
    }

    if (syntax.isObjectLiteralExpression(node)) {
        return node.properties;
    }

    return [];
}

function needsSpace(previous: syntax.Node, current: syntax.Node): boolean {
    if (syntax.isImportDeclaration(previous) && !syntax.isImportDeclaration(current)) {
        return true;
    }

    return (
        isBoundary(previous) ||
        isBoundary(current) ||
        syntax.isReturnStatement(current) ||
        syntax.isThrowStatement(current)
    );
}

function isBoundary(node: syntax.Node): boolean {
    if (
        syntax.isPropertyAssignment(node) &&
        (syntax.isArrowFunction(node.initializer) || syntax.isFunctionExpression(node.initializer))
    ) {
        return true;
    }

    return (
        syntax.isIfStatement(node) ||
        syntax.isForStatement(node) ||
        syntax.isForOfStatement(node) ||
        syntax.isForInStatement(node) ||
        syntax.isWhileStatement(node) ||
        syntax.isDoStatement(node) ||
        syntax.isTryStatement(node) ||
        syntax.isSwitchStatement(node) ||
        syntax.isFunctionDeclaration(node) ||
        syntax.isMethodDeclaration(node) ||
        syntax.isConstructorDeclaration(node) ||
        syntax.isGetAccessorDeclaration(node) ||
        syntax.isSetAccessorDeclaration(node) ||
        syntax.isClassDeclaration(node) ||
        syntax.isInterfaceDeclaration(node) ||
        syntax.isTypeAliasDeclaration(node) ||
        syntax.isEnumDeclaration(node)
    );
}
