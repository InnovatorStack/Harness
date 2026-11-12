import { relative, resolve } from "node:path";

import * as syntax from "typescript/unstable/ast";
import { SymbolFlags } from "typescript/unstable/async";
import type { Project, Symbol as CompilerSymbol } from "typescript/unstable/async";

import type { StyleDiagnostic } from "./typescript.js";

interface FunctionRecord {
    readonly node: syntax.Node;
    readonly edges: Set<string>;
}

interface CallSite {
    readonly owner: string;
    readonly expression: syntax.Node;
    readonly delayedBy?: syntax.Expression;
    readonly access?: "read" | "write" | "construct";
}

/** Resolve symbols across files: matching function names is not sufficient to detect recursion. */
export async function checkRecursion(
    project: Project,
    sources: readonly syntax.SourceFile[],
    directory: string,
): Promise<readonly StyleDiagnostic[]> {
    const functions = new Map<string, FunctionRecord>();
    const calls: CallSite[] = [];

    for (const source of sources) {
        collectFunctions(source, functions, calls);
    }

    const symbols = await project.checker.getSymbolAtLocation(calls.map((call) => call.expression));

    for (const [index, call] of calls.entries()) {
        let symbol = symbols[index];

        if (!symbol) {
            continue;
        }

        if (symbol.flags & SymbolFlags.Alias) {
            symbol = await project.checker.getAliasedSymbol(symbol);
        }

        const declaration = await resolveTarget(symbol, call);

        if (!declaration || !functions.has(key(declaration))) {
            continue;
        }

        if (
            isGenerator(declaration) &&
            call.delayedBy &&
            (await isImportTask(project, call.delayedBy, directory))
        ) {
            continue;
        }

        functions.get(call.owner)?.edges.add(key(declaration));
    }

    const diagnostics: StyleDiagnostic[] = [];

    for (const [id, record] of functions) {
        const cycle = findCycle(id, functions);

        if (cycle) {
            diagnostics.push(diagnostic(record.node, directory, cycle));
        }
    }

    return diagnostics;
}

async function resolveTarget(
    symbol: CompilerSymbol,
    call: CallSite,
): Promise<syntax.Node | undefined> {
    let declaration = await symbol.valueDeclaration?.resolve();

    if (call.access === "read" || call.access === "write") {
        const declarations = await Promise.all(symbol.declarations.map((entry) => entry.resolve()));

        return declarations.find(
            (entry) =>
                entry !== undefined &&
                (call.access === "write"
                    ? syntax.isSetAccessorDeclaration(entry)
                    : syntax.isGetAccessorDeclaration(entry)),
        );
    }

    if (declaration && syntax.isClassDeclaration(declaration)) {
        return declaration.members.find(syntax.isConstructorDeclaration);
    }

    if (
        declaration &&
        (syntax.isVariableDeclaration(declaration) || syntax.isPropertyAssignment(declaration))
    ) {
        declaration = declaration.initializer;
    }

    return declaration;
}

function isGenerator(node: syntax.Node): boolean {
    if (
        syntax.isFunctionDeclaration(node) ||
        syntax.isFunctionExpression(node) ||
        syntax.isMethodDeclaration(node)
    ) {
        return node.asteriskToken !== undefined;
    }

    return false;
}

function collectFunctions(
    source: syntax.SourceFile,
    functions: Map<string, FunctionRecord>,
    calls: CallSite[],
): void {
    const pending: { node: syntax.Node; owner?: string }[] = [{ node: source }];

    while (pending.length > 0) {
        const frame = pending.pop();

        if (!frame) {
            throw new Error("A syntax frame must exist while call collection is pending.");
        }

        const node = frame.node;
        let owner = frame.owner;

        if (isFunction(node)) {
            owner = key(node);
            functions.set(owner, { node, edges: new Set() });
        }

        if (owner && syntax.isCallExpression(node)) {
            collectCall(node, owner, functions, calls);
        }

        if (owner && syntax.isNewExpression(node)) {
            calls.push({ owner, expression: node.expression, access: "construct" });
        }

        if (owner && syntax.isPropertyAccessExpression(node)) {
            const parent = node.parent;
            const writing =
                syntax.isBinaryExpression(parent) &&
                parent.left === node &&
                parent.operatorToken.kind === syntax.SyntaxKind.EqualsToken;
            calls.push({ owner, expression: node, access: writing ? "write" : "read" });
        }

        node.forEachChild((child) => {
            pending.push({ node: child, ...(owner ? { owner } : {}) });
        });
    }
}

function collectCall(
    node: syntax.CallExpression,
    owner: string,
    functions: Map<string, FunctionRecord>,
    calls: CallSite[],
): void {
    const parent = node.parent;

    if (syntax.isNewExpression(parent) && parent.arguments?.includes(node)) {
        calls.push({ owner, expression: node.expression, delayedBy: parent.expression });
    } else {
        calls.push({ owner, expression: node.expression });
    }

    for (const argument of node.arguments) {
        if (isFunction(argument)) {
            functions.get(owner)?.edges.add(key(argument));
        } else if (syntax.isIdentifier(argument) || syntax.isPropertyAccessExpression(argument)) {
            calls.push({ owner, expression: argument });
        }
    }
}

function isFunction(node: syntax.Node): boolean {
    return (
        syntax.isFunctionDeclaration(node) ||
        syntax.isFunctionExpression(node) ||
        syntax.isArrowFunction(node) ||
        syntax.isMethodDeclaration(node) ||
        syntax.isConstructorDeclaration(node) ||
        syntax.isGetAccessorDeclaration(node) ||
        syntax.isSetAccessorDeclaration(node)
    );
}

function key(node: syntax.Node): string {
    return `${node.getSourceFile().fileName}:${node.getStart()}`;
}

async function isImportTask(
    project: Project,
    expression: syntax.Expression,
    directory: string,
): Promise<boolean> {
    let symbol = await project.checker.getSymbolAtLocation(expression);

    if (!symbol) {
        return false;
    }

    if (symbol.flags & SymbolFlags.Alias) {
        symbol = await project.checker.getAliasedSymbol(symbol);
    }

    const declaration = await symbol.valueDeclaration?.resolve();

    if (!declaration || !syntax.isClassDeclaration(declaration)) {
        return false;
    }

    return (
        declaration.name?.text === "ImportTask" &&
        declaration.getSourceFile().fileName === resolve(directory, "src/packages/evaluation.ts")
    );
}

function findCycle(
    id: string,
    functions: ReadonlyMap<string, FunctionRecord>,
): readonly string[] | undefined {
    const pending = [...(functions.get(id)?.edges ?? [])].map((next) => ({ next, path: [id] }));
    const visited = new Set<string>();

    while (pending.length > 0) {
        const frame = pending.pop();

        if (!frame) {
            throw new Error("A call frame must exist while cycle detection is pending.");
        }

        if (frame.next === id) {
            return [...frame.path, id];
        }

        if (visited.has(frame.next)) {
            continue;
        }

        visited.add(frame.next);

        for (const next of functions.get(frame.next)?.edges ?? []) {
            pending.push({ next, path: [...frame.path, frame.next] });
        }
    }

    return undefined;
}

function diagnostic(
    node: syntax.Node,
    directory: string,
    cycle: readonly string[],
): StyleDiagnostic {
    return {
        file: relative(directory, node.getSourceFile().fileName),
        line: node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1,
        rule: "recursion",
        message: `Recursive execution is forbidden (${cycle.length - 1} call edges). Use a bounded work stack.`,
    };
}
