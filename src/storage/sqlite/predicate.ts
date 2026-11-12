import { validatePredicate } from "../../queries/predicates.js";
import { Comparison } from "../../queries/types.js";
import type { Predicate, QueryField } from "../../queries/types.js";
import { valueKey } from "../../queries/values.js";
import type { HarnessStorage, ItemTypeDefinition, StorageValue } from "../types.js";
import { quoteIdentifier, tableName } from "./schema.js";

export interface CompiledPredicate {
    readonly sql: string;
    readonly parameters: readonly StorageValue[];
}

interface Bounds {
    readonly yes: string;
    readonly no: string;
}

const uncertain: Bounds = { yes: "1", no: "1" };

/** Conservative pushdown: SQL may retain extra rows but must never exclude a true predicate. */
export function compilePredicate(
    storage: HarnessStorage,
    definition: ItemTypeDefinition,
    root: Predicate,
): CompiledPredicate {
    validatePredicate(root);

    return new PredicateCompiler(storage, definition).compile(root);
}

class PredicateCompiler {
    private readonly parameters: StorageValue[] = [];
    private readonly joins: string[] = [];
    private readonly paths = new Map<string, string>();

    constructor(
        private readonly storage: HarnessStorage,
        private readonly definition: ItemTypeDefinition,
    ) {}

    compile(root: Predicate): CompiledPredicate {
        const fragments = new Map<Predicate, Bounds>();
        const pending = [{ node: root, expanded: false }];

        while (pending.length > 0) {
            const frame = pending.pop();

            if (!frame) {
                throw new Error("A SQL predicate frame must exist while compilation is pending.");
            }

            const node = frame.node;

            if (
                !frame.expanded &&
                (node.kind === "and" || node.kind === "or" || node.kind === "not")
            ) {
                pending.push({ node, expanded: true });
                const children = node.kind === "not" ? [node.term] : node.terms;

                for (const child of children) {
                    pending.push({ node: child, expanded: false });
                }
            } else {
                fragments.set(node, this.expression(node, fragments));
            }
        }

        const where = fragment(fragments, root).yes;
        const table = quoteIdentifier(tableName(this.definition));
        this.parameters.push(this.definition.name);
        const presence = `LEFT JOIN _harness_presence AS p ON p.type = ?${this.parameters.length} COLLATE NOCASE AND p.id = r.id COLLATE NOCASE`;

        return {
            sql: `SELECT r.*, p.properties AS _harness_presence FROM ${table} AS r ${this.joins.join(" ")} ${presence} WHERE ${where} ORDER BY r.id COLLATE BINARY`,
            parameters: this.parameters,
        };
    }

    private expression(node: Predicate, fragments: ReadonlyMap<Predicate, Bounds>): Bounds {
        if (node.kind === "constant") {
            return { yes: node.value ? "1" : "0", no: node.value ? "0" : "1" };
        }

        if (node.kind === "and" || node.kind === "or") {
            const values = node.terms.map((term) => fragment(fragments, term));

            return {
                yes: joined(
                    values.map((value) => value.yes),
                    node.kind,
                ),
                no: joined(
                    values.map((value) => value.no),
                    node.kind === "and" ? "or" : "and",
                ),
            };
        }

        if (node.kind === "not") {
            const child = fragment(fragments, node.term);

            return { yes: child.no, no: child.yes };
        }

        const column = this.column(node.field);

        if (node.kind === "null") {
            return exact(`${column} IS ${node.negate ? "NOT " : ""}NULL`);
        }

        if (node.field.kind === "date") {
            return uncertain;
        }

        if (node.kind === "like") {
            if (node.pattern.length > 50_000 || node.pattern.includes("\0")) {
                return uncertain;
            }

            const expression = `${column} LIKE ${this.parameter(node.pattern)}`;
            const bounds = { yes: exact(expression).yes, no: "1" };

            if (node.field.kind === "identifier") {
                return uncertain;
            }

            return node.negate ? { yes: bounds.no, no: bounds.yes } : bounds;
        }

        if (node.kind === "set") {
            return this.set(node, column);
        }

        return this.comparison(node, column);
    }

    private comparison(node: Extract<Predicate, { kind: "compare" }>, column: string): Bounds {
        if (node.field.kind === "decimal") {
            const value = this.parameter(node.value);
            const equal = `CAST(${column} AS REAL) = CAST(${value} AS REAL)`;

            if (node.operator === Comparison.Equal) {
                return { yes: exact(equal).yes, no: "1" };
            }

            if (node.operator === Comparison.NotEqual) {
                return { yes: "1", no: exact(equal).yes };
            }

            const greater = [Comparison.Greater, Comparison.GreaterOrEqual].includes(node.operator);

            return {
                yes: exact(
                    `CAST(${column} AS REAL) ${greater ? ">=" : "<="} CAST(${value} AS REAL)`,
                ).yes,
                no: exact(`CAST(${column} AS REAL) ${greater ? "<=" : ">="} CAST(${value} AS REAL)`)
                    .yes,
            };
        }

        const value = this.parameter(valueKey(node.field.kind, node.value));
        const collation = node.field.kind === "identifier" ? "NOCASE" : "BINARY";
        const bounds = exact(
            `${column} COLLATE ${collation} ${sqlOperator(node.operator)} ${value}`,
        );

        return node.field.kind === "identifier" ? asciiBounds(column, bounds) : bounds;
    }

    private set(node: Extract<Predicate, { kind: "set" }>, column: string): Bounds {
        if (node.values.length === 0) {
            return node.negate ? { yes: "1", no: "0" } : { yes: "0", no: "1" };
        }

        const decimal = node.field.kind === "decimal";
        const values = node.values.map((value) => this.parameter(valueKey(node.field.kind, value)));
        const left = decimal ? `CAST(${column} AS REAL)` : column;
        const right = decimal ? values.map((value) => `CAST(${value} AS REAL)`) : values;
        const collation = node.field.kind === "identifier" ? "NOCASE" : "BINARY";
        let bounds = exact(`${left} COLLATE ${collation} IN (${right.join(", ")})`);

        if (decimal) {
            bounds = { yes: bounds.yes, no: "1" };
        } else if (node.field.kind === "identifier") {
            bounds = asciiBounds(column, bounds);
        }

        return node.negate ? { yes: bounds.no, no: bounds.yes } : bounds;
    }

    private column(field: QueryField): string {
        let parent = "r";
        let definition = this.definition;
        const path: string[] = [];

        for (const reference of field.path) {
            const target = this.storage.getItemType(reference.target);

            if (
                !target ||
                !definition.properties.some((property) => property.name === reference.property)
            ) {
                throw new TypeError("A foreign query path must refer to imported metadata.");
            }

            path.push(reference.property, target.name);
            const key = JSON.stringify(path);
            let alias = this.paths.get(key);

            if (!alias) {
                if (this.paths.size >= 48) {
                    throw new RangeError("Query exceeds the SQLite join budget.");
                }

                alias = `q${this.paths.size + 1}`;
                this.paths.set(key, alias);
                const table = quoteIdentifier(tableName(target));
                const source = `${parent}.${quoteIdentifier(reference.property)}`;
                this.joins.push(
                    `LEFT JOIN ${table} AS ${alias} ON ${alias}.id = ${source} COLLATE NOCASE`,
                );
            }

            parent = alias;
            definition = target;
        }

        if (
            field.column !== "id" &&
            !definition.properties.some((property) => property.name === field.column)
        ) {
            throw new TypeError("A query column must refer to imported metadata.");
        }

        return `${parent}.${quoteIdentifier(field.column)}`;
    }

    private parameter(value: StorageValue): string {
        this.parameters.push(value);

        return `?${this.parameters.length}`;
    }
}

function fragment(fragments: ReadonlyMap<Predicate, Bounds>, node: Predicate): Bounds {
    const result = fragments.get(node);

    if (!result) {
        throw new Error("SQL operands must be compiled before their parent.");
    }

    return result;
}

function joined(terms: readonly string[], kind: "and" | "or"): string {
    if (terms.length === 0) {
        return kind === "and" ? "1" : "0";
    }

    return `(${terms.join(kind === "and" ? " AND " : " OR ")})`;
}

function exact(expression: string): Bounds {
    return { yes: `((${expression}) IS TRUE)`, no: `((${expression}) IS FALSE)` };
}

function asciiBounds(column: string, bounds: Bounds): Bounds {
    return {
        yes: `(${column} GLOB '*[^ -~]*' OR ${bounds.yes})`,
        no: `(${column} GLOB '*[^ -~]*' OR ${bounds.no})`,
    };
}

function sqlOperator(operator: Comparison): string {
    switch (operator) {
        case Comparison.Equal: {
            return "=";
        }
        case Comparison.NotEqual: {
            return "<>";
        }
        case Comparison.Greater: {
            return ">";
        }
        case Comparison.GreaterOrEqual: {
            return ">=";
        }
        case Comparison.Less: {
            return "<";
        }
        case Comparison.LessOrEqual: {
            return "<=";
        }
        default: {
            const unexpected: never = operator;

            throw new TypeError(`Unknown SQL comparison '${String(unexpected)}'.`);
        }
    }
}
