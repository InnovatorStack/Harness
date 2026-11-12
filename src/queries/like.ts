import { workUnitsMax } from "../core/limits.js";
import { queryTextMax } from "./types.js";

/** SQL wildcards operate on Unicode characters. This bounded matcher never builds a regex. */
export function like(value: string, pattern: string): boolean {
    if (pattern.length > queryTextMax || pattern.includes("[") || pattern.includes("]")) {
        throw new TypeError(
            "LIKE supports '%' and '_' wildcards; bracket classes are not implemented.",
        );
    }

    if (value.length * Math.max(1, pattern.length) > workUnitsMax) {
        throw new RangeError("LIKE matching exceeds its work budget.");
    }

    const text = characters(value);
    const tokens = characters(pattern);

    let previous = Array.from({ length: text.length + 1 }, () => false);
    previous[0] = true;

    for (const token of tokens) {
        const current = Array.from({ length: text.length + 1 }, () => false);
        current[0] = token === "%" && previous[0] === true;

        for (let index = 1; index <= text.length; index += 1) {
            current[index] =
                token === "%"
                    ? previous[index] === true || current[index - 1] === true
                    : previous[index - 1] === true && (token === "_" || token === text[index - 1]);
        }

        previous = current;
    }

    return previous[text.length] === true;
}

function characters(value: string): string[] {
    const result: string[] = [];

    for (const character of value) {
        result.push(character);
    }

    return result;
}
