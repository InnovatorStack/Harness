import type { StorageValue } from "../storage/types.js";
import { like } from "./like.js";
import { queryDepthMax, queryNodesMax, queryTextMax, queryValuesMax } from "./types.js";
import type { Comparison, Predicate, QueryField } from "./types.js";
import { valueKey } from "./values.js";

export function comparison(
    field: QueryField,
    operator: Comparison,
    value: StorageValue,
): Predicate {
    validateValue(field, value);

    return { kind: "compare", field, operator, value };
}

export function setPredicate(
    field: QueryField,
    values: readonly StorageValue[],
    negate = false,
): Predicate {
    if (values.length > queryValuesMax) {
        throw new TypeError("Query set exceeds its value limit.");
    }

    for (const value of values) {
        validateValue(field, value);
    }

    return { kind: "set", field, values, negate };
}

export function likePredicate(field: QueryField, pattern: string, negate = false): Predicate {
    if (!["text", "identifier"].includes(field.kind)) {
        throw new TypeError("LIKE requires a text or item-ID property.");
    }

    like("", pattern);

    return { kind: "like", field, pattern, negate };
}

export function validatePredicate(root: Predicate): void {
    const pending = [{ node: root, depth: 0 }];
    let visited = 0;
    let values = 0;

    while (pending.length > 0) {
        const frame = pending.pop();

        if (!frame) {
            throw new Error("A query frame must exist while validation is pending.");
        }

        visited += 1;

        if (visited > queryNodesMax || frame.depth > queryDepthMax) {
            throw new TypeError("Query exceeds its predicate or nesting limit.");
        }

        if (frame.node.kind === "not") {
            pending.push({ node: frame.node.term, depth: frame.depth + 1 });
        } else if (frame.node.kind === "and" || frame.node.kind === "or") {
            for (const node of frame.node.terms) {
                pending.push({ node, depth: frame.depth + 1 });
            }
        } else if (frame.node.kind === "set") {
            values += frame.node.values.length;
        } else if (frame.node.kind !== "constant" && frame.node.kind !== "null") {
            values += 1;
        }

        if (values > queryValuesMax) {
            throw new TypeError("Query exceeds its parameter limit.");
        }
    }
}

function validateValue(field: QueryField, value: StorageValue): void {
    if (typeof value === "string" && value.length > queryTextMax) {
        throw new TypeError("Query values exceed their text limit.");
    }

    valueKey(field.kind, value);
}
