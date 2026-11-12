import type { StorageValue } from "../storage/types.js";
import { dateKey } from "./date.js";
import { compareDecimals, decimalKey } from "./decimal.js";
import type { ValueKind } from "./types.js";

export function valueKey(kind: ValueKind, value: StorageValue): StorageValue {
    if (value === null) {
        return null;
    }

    if (kind === "number") {
        const result = Number(value);

        if (String(value).trim() === "" || !Number.isFinite(result)) {
            throw new TypeError("Numeric predicates require finite numeric values.");
        }

        return result;
    }

    const text = String(value);

    switch (kind) {
        case "decimal": {
            return decimalKey(text);
        }
        case "date": {
            return dateKey(text);
        }
        case "identifier": {
            return text.toLowerCase();
        }
        case "text": {
            return text;
        }
        default: {
            const unexpected: never = kind;

            throw new TypeError(`Unknown query value kind '${String(unexpected)}'.`);
        }
    }
}

export function compareValues(
    kind: ValueKind,
    left: StorageValue,
    right: StorageValue,
): number | null {
    const a = valueKey(kind, left);
    const b = valueKey(kind, right);

    if (a === null || b === null) {
        return null;
    }

    if (a === b) {
        return 0;
    }

    if (kind === "decimal") {
        return compareDecimals(String(a), String(b));
    }

    if (kind === "date") {
        return BigInt(a) < BigInt(b) ? -1 : 1;
    }

    if (typeof a === "number" && typeof b === "number") {
        return a < b ? -1 : 1;
    }

    return compareText(String(a), String(b));
}

function compareText(left: string, right: string): number {
    const a = left[Symbol.iterator]();
    const b = right[Symbol.iterator]();

    while (true) {
        const first = a.next();
        const second = b.next();

        if (first.done || second.done) {
            if (first.done && second.done) {
                return 0;
            }

            return first.done ? -1 : 1;
        }

        const firstCode = first.value.codePointAt(0);
        const secondCode = second.value.codePointAt(0);

        if (firstCode === undefined || secondCode === undefined) {
            throw new Error("String iteration must yield one Unicode code point.");
        }

        const difference = firstCode - secondCode;

        if (difference !== 0) {
            return Math.sign(difference);
        }
    }
}
