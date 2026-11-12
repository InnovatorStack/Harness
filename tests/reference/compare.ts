import { assertDataTree, cloneData, freezeData, getOwn } from "../../src/core/data.js";
import { object } from "../../src/items/codec.js";
import { normalizeObservation } from "./normalize.js";
import type { Difference, Observation } from "./types.js";

const differencesMax = 100;

export interface Comparison {
    readonly matches: boolean;
    readonly differences: readonly Difference[];
    readonly truncated: boolean;
}

/** Arrays retain order except state sets, whose declared business keys control normalization. */
export function compareObservations(
    expected: Observation,
    actual: Observation,
    anchors: ReadonlySet<string>,
): Comparison {
    return compareData(
        normalizeObservation(expected, anchors),
        normalizeObservation(actual, anchors),
    );
}

export function compareData(expected: unknown, actual: unknown): Comparison {
    assertDataTree(expected);
    assertDataTree(actual);
    const differences: Difference[] = [];
    const pending = [{ path: "", expected, actual }];

    while (pending.length > 0 && differences.length < differencesMax) {
        const entry = pending.pop();

        if (!entry) {
            throw new Error("A comparison frame must exist while work is pending.");
        }

        const left = entry.expected;
        const right = entry.actual;

        if (Array.isArray(left) && Array.isArray(right)) {
            if (left.length !== right.length) {
                differences.push({
                    path: `${entry.path}/length`,
                    expected: left.length,
                    actual: right.length,
                });
            }

            for (let index = Math.min(left.length, right.length) - 1; index >= 0; index -= 1) {
                const expected: unknown = left[index];
                const actual: unknown = right[index];
                pending.push({ path: `${entry.path}/${index}`, expected, actual });
            }
        } else if (object(left) && object(right)) {
            const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])]
                .sort()
                .reverse();

            for (const key of keys) {
                pending.push({
                    path: `${entry.path}/${pointer(key)}`,
                    expected: getOwn(left, key),
                    actual: getOwn(right, key),
                });
            }
        } else if (left !== right) {
            differences.push(entry);
        }
    }

    return freezeData(
        cloneData({
            matches: differences.length === 0,
            differences,
            truncated: pending.length > 0,
        }),
    );
}

function pointer(value: string): string {
    return value.replaceAll("~", "~0").replaceAll("/", "~1");
}
