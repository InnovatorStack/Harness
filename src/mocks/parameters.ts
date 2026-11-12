import { assertDataTree } from "../core/data.js";
import { object } from "../items/codec.js";
import type { MockValue } from "./types.js";

export function validateParameters(
    value: unknown,
    path: string,
): asserts value is Readonly<Record<string, MockValue>> {
    if (!object(value)) {
        throw new TypeError(`${path} must be an object of property matches.`);
    }

    try {
        assertDataTree(value, { allowArrays: false, allowUndefined: false });
    } catch (error) {
        throw new TypeError(`${path} contains an invalid or circular property match.`, {
            cause: error,
        });
    }
}
