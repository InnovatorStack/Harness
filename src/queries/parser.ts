import type { StorageValue } from "../storage/types.js";
import { TokenKind, tokenize } from "./lexer.js";
import type { Token } from "./lexer.js";
import { comparison, likePredicate, setPredicate, validatePredicate } from "./predicates.js";
import { Comparison, queryDepthMax, queryNodesMax, queryValuesMax } from "./types.js";
import type { Predicate, QueryField } from "./types.js";

type Resolver = (names: readonly string[]) => QueryField;

type Operator = "and" | "or" | "not" | "(";

export class PredicateParser {
    private offset = 0;
    private reductions = 0;
    private readonly tokens: readonly Token[];
    private readonly values: Predicate[] = [];
    private readonly operators: Operator[] = [];

    constructor(
        text: string,
        private readonly field: Resolver,
    ) {
        this.tokens = tokenize(text);
    }

    parse(): Predicate {
        let operand = true;
        let depth = 0;

        while (this.offset < this.tokens.length) {
            if (operand) {
                if (this.take("(")) {
                    this.operators.push("(");
                    depth += 1;
                } else if (this.takeWord("not")) {
                    this.operators.push("not");
                } else {
                    this.values.push(this.predicate());
                    operand = false;
                }
            } else if (this.take(")")) {
                while (this.operators.at(-1) !== "(") {
                    this.reduce();
                }

                this.operators.pop();
                depth -= 1;
            } else {
                const operator = this.binaryOperator();

                while (
                    this.operators.at(-1) !== undefined &&
                    precedence(this.operators.at(-1)) >= precedence(operator)
                ) {
                    this.reduce();
                }

                this.operators.push(operator);
                operand = true;
            }

            if (depth < 0 || depth > queryDepthMax) {
                this.fail("Unbalanced or excessive query parentheses");
            }
        }

        if (operand || depth !== 0) {
            this.fail("Incomplete query expression");
        }

        while (this.operators.length > 0) {
            this.reduce();
        }

        const result = this.values[0];

        if (!result || this.values.length !== 1) {
            return this.fail("Invalid query expression");
        }

        validatePredicate(result);

        return result;
    }

    scalarList(): readonly StorageValue[] {
        const values = this.list(false);

        if (this.offset !== this.tokens.length) {
            this.fail("Unexpected query value");
        }

        return values;
    }

    range(): readonly [StorageValue, StorageValue] {
        const first = this.literal();
        this.requireWord("and");
        const last = this.literal();

        if (this.offset !== this.tokens.length) {
            this.fail("Unexpected range value");
        }

        return [first, last];
    }

    private predicate(): Predicate {
        const field = this.field(this.identifiers());
        const negate = this.takeWord("not");

        if (this.takeWord("in")) {
            this.require("(");

            return setPredicate(field, this.list(true), negate);
        }

        if (this.takeWord("like")) {
            const pattern = this.literal();

            if (typeof pattern !== "string") {
                return this.fail("LIKE requires a quoted pattern");
            }

            return likePredicate(field, pattern, negate);
        }

        if (this.takeWord("between")) {
            const first = this.literal();
            this.requireWord("and");
            const last = this.literal();
            const term: Predicate = {
                kind: "and",
                terms: [
                    comparison(field, Comparison.GreaterOrEqual, first),
                    comparison(field, Comparison.LessOrEqual, last),
                ],
            };

            return negate ? { kind: "not", term } : term;
        }

        if (negate) {
            return this.fail("NOT must precede IN, LIKE or BETWEEN");
        }

        if (this.takeWord("is")) {
            const negate = this.takeWord("not");
            this.requireWord("null");

            return { kind: "null", field, negate };
        }

        const token = this.tokens[this.offset++];
        const operator = comparisonOperator(token?.value);

        if (operator === undefined) {
            return this.fail("Expected a supported comparison operator");
        }

        return comparison(field, operator, this.literal());
    }

    private identifiers(): readonly string[] {
        const names: string[] = [];

        do {
            const token = this.tokens[this.offset++];

            if (!token || ![TokenKind.Word, TokenKind.Identifier].includes(token.kind)) {
                return this.fail("Expected a property identifier");
            }

            names.push(token.value);

            if (names.length > 3) {
                return this.fail("Cross-database query qualifiers are not supported");
            }
        } while (this.take("."));

        return names;
    }

    private literal(): StorageValue {
        if (this.takeWord("null")) {
            return null;
        }

        const token = this.tokens[this.offset++];

        if (!token || ![TokenKind.String, TokenKind.Number].includes(token.kind)) {
            return this.fail("Expected a quoted string, number or NULL literal");
        }

        return token.value;
    }

    private list(parenthesized: boolean): readonly StorageValue[] {
        const values: StorageValue[] = [];

        do {
            values.push(this.literal());

            if (values.length > queryValuesMax) {
                return this.fail("Query value limit exceeded");
            }
        } while (this.take(","));

        if (parenthesized) {
            this.require(")");
        }

        return values;
    }

    private binaryOperator(): "and" | "or" {
        if (this.takeWord("and")) {
            return "and";
        }

        if (this.takeWord("or")) {
            return "or";
        }

        return this.fail("Expected AND, OR or a closing parenthesis");
    }

    private reduce(): void {
        this.reductions += 1;

        if (this.reductions > queryNodesMax) {
            this.fail("Query exceeds its predicate limit");
        }

        const operator = this.operators.pop();
        const right = this.values.pop();

        if (!right || operator === undefined || operator === "(") {
            this.fail("Unbalanced query expression");
        }

        if (operator === "not") {
            this.values.push({ kind: "not", term: right });

            return;
        }

        const left = this.values.pop();

        if (!left) {
            this.fail("Missing query operand");
        }

        const terms = left.kind === operator ? [...left.terms, right] : [left, right];
        this.values.push({ kind: operator, terms });
    }

    private take(value: string): boolean {
        const token = this.tokens[this.offset];

        if (token?.kind === TokenKind.Symbol && token.value === value) {
            this.offset += 1;

            return true;
        }

        return false;
    }

    private takeWord(value: string): boolean {
        const token = this.tokens[this.offset];

        if (token?.kind === TokenKind.Word && token.value.toLowerCase() === value) {
            this.offset += 1;

            return true;
        }

        return false;
    }

    private require(value: string): void {
        if (!this.take(value)) {
            this.fail(`Expected '${value}'`);
        }
    }

    private requireWord(value: string): void {
        if (!this.takeWord(value)) {
            this.fail(`Expected ${value.toUpperCase()}`);
        }
    }

    private fail(message: string): never {
        const position = this.tokens[this.offset]?.position ?? this.tokens.at(-1)?.position ?? 0;

        throw new TypeError(`${message} at query position ${position + 1}.`);
    }
}

function precedence(operator: Operator | undefined): number {
    switch (operator) {
        case "not": {
            return 3;
        }
        case "and": {
            return 2;
        }
        case "or": {
            return 1;
        }
        case undefined:
        case "(": {
            return 0;
        }
        default: {
            const unexpected: never = operator;

            throw new Error(`Unknown query operator ${String(unexpected)}.`);
        }
    }
}

function comparisonOperator(value: string | undefined): Comparison | undefined {
    switch (value) {
        case undefined: {
            return undefined;
        }
        case "=": {
            return Comparison.Equal;
        }
        case "!=":
        case "<>": {
            return Comparison.NotEqual;
        }
        case ">": {
            return Comparison.Greater;
        }
        case ">=": {
            return Comparison.GreaterOrEqual;
        }
        case "<": {
            return Comparison.Less;
        }
        case "<=": {
            return Comparison.LessOrEqual;
        }
        default: {
            return undefined;
        }
    }
}
