import type { StorageValue } from "../storage/types.js";
import { like } from "./like.js";
import { Comparison } from "./types.js";
import type { Predicate, QueryField } from "./types.js";
import { compareValues } from "./values.js";

type Truth = boolean | null;

/** SQL three-valued logic is shared with the SQLite adapter, including NOT and NULL in sets. */
export function evaluate(
    root: Predicate,
    read: (field: QueryField) => StorageValue,
    spend: (units: number) => void,
): boolean {
    const values = new Map<Predicate, Truth>();
    const pending = [{ node: root, expanded: false }];

    while (pending.length > 0) {
        const frame = pending.pop();

        if (!frame) {
            throw new Error("A predicate frame must exist while evaluation is pending.");
        }

        spend(1);
        const node = frame.node;

        if (!frame.expanded && (node.kind === "and" || node.kind === "or" || node.kind === "not")) {
            pending.push({ node, expanded: true });
            const terms = node.kind === "not" ? [node.term] : node.terms;

            for (const node of terms) {
                pending.push({ node, expanded: false });
            }
        } else {
            values.set(node, truth(node, values, read, spend));
        }
    }

    return values.get(root) === true;
}

function truth(
    node: Predicate,
    values: ReadonlyMap<Predicate, Truth>,
    read: (field: QueryField) => StorageValue,
    spend: (units: number) => void,
): Truth {
    if (node.kind === "constant") {
        return node.value;
    }

    if (node.kind === "not") {
        return negate(required(values, node.term));
    }

    if (node.kind === "and" || node.kind === "or") {
        const terms = node.terms.map((term) => required(values, term));

        return groupTruth(node.kind, terms);
    }

    const actual = read(node.field);

    if (node.kind === "null") {
        return node.negate ? actual !== null : actual === null;
    }

    if (node.kind === "set") {
        let result: Truth = false;

        for (const value of node.values) {
            spend(String(actual ?? "").length + String(value ?? "").length + 1);
            const comparison = compareValues(node.field.kind, actual, value);

            if (comparison === 0) {
                result = true;
                break;
            }

            if (comparison === null) {
                result = null;
            }
        }

        return node.negate ? negate(result) : result;
    }

    if (actual === null) {
        return null;
    }

    if (node.kind === "like") {
        const text = String(actual);
        spend(Math.max(1, text.length * Math.max(1, node.pattern.length)));
        const pattern =
            node.field.kind === "identifier" ? node.pattern.toLowerCase() : node.pattern;
        const result = like(node.field.kind === "identifier" ? text.toLowerCase() : text, pattern);

        return node.negate ? !result : result;
    }

    spend(String(actual).length + String(node.value ?? "").length + 1);

    return comparisonResult(node.operator, compareValues(node.field.kind, actual, node.value));
}

export function comparisonResult(operator: Comparison, result: number | null): Truth {
    if (result === null) {
        return null;
    }

    switch (operator) {
        case Comparison.Equal: {
            return result === 0;
        }
        case Comparison.NotEqual: {
            return result !== 0;
        }
        case Comparison.Greater: {
            return result > 0;
        }
        case Comparison.GreaterOrEqual: {
            return result >= 0;
        }
        case Comparison.Less: {
            return result < 0;
        }
        case Comparison.LessOrEqual: {
            return result <= 0;
        }
        default: {
            const unexpected: never = operator;

            throw new Error(`Unknown comparison '${String(unexpected)}'.`);
        }
    }
}

function negate(value: Truth): Truth {
    return value === null ? null : !value;
}

function groupTruth(kind: "and" | "or", terms: readonly Truth[]): Truth {
    if (kind === "and" && terms.includes(false)) {
        return false;
    }

    if (kind === "or" && terms.includes(true)) {
        return true;
    }

    if (terms.includes(null)) {
        return null;
    }

    return kind === "and";
}

function required(values: ReadonlyMap<Predicate, Truth>, node: Predicate): Truth {
    const value = values.get(node);

    if (value === undefined) {
        throw new Error("Predicate operands must be evaluated before their parent.");
    }

    return value;
}
