import type { StorageValue, StoredItem } from "../storage/types.js";

export enum Comparison {
    Equal = "eq",
    NotEqual = "ne",
    Greater = "gt",
    GreaterOrEqual = "ge",
    Less = "lt",
    LessOrEqual = "le",
}

export type ValueKind = "text" | "identifier" | "number" | "decimal" | "date";

export interface ReferencePath {
    readonly property: string;
    readonly target: string;
}

export interface QueryField {
    readonly name: string;
    readonly column: string;
    readonly kind: ValueKind;
    readonly path: readonly ReferencePath[];
}

export type Predicate =
    | { readonly kind: "constant"; readonly value: boolean }
    | {
          readonly kind: "compare";
          readonly field: QueryField;
          readonly operator: Comparison;
          readonly value: StorageValue;
      }
    | { readonly kind: "null"; readonly field: QueryField; readonly negate: boolean }
    | {
          readonly kind: "set";
          readonly field: QueryField;
          readonly values: readonly StorageValue[];
          readonly negate: boolean;
      }
    | {
          readonly kind: "like";
          readonly field: QueryField;
          readonly pattern: string;
          readonly negate: boolean;
      }
    | { readonly kind: "and"; readonly terms: readonly Predicate[] }
    | { readonly kind: "or"; readonly terms: readonly Predicate[] }
    | { readonly kind: "not"; readonly term: Predicate };

export interface QueryOrder {
    readonly field: QueryField;
    readonly descending: boolean;
}

/** Internal optimization; custom storage uses the same final predicate evaluator. */
export type SelectQuery = (
    type: string,
    predicate: Predicate,
    spend: (units: number) => void,
) => readonly StoredItem[];

export const selectQuery = Symbol("Harness storage selection");

export const queryNodesMax = 512;
export const queryDepthMax = 64;
export const queryValuesMax = 10_000;
export const queryTextMax = 64 * 1024;

export function conjunction(terms: readonly Predicate[]): Predicate {
    if (terms.length === 0) {
        return { kind: "constant", value: true };
    }

    const only = terms[0];

    if (terms.length === 1 && only) {
        return only;
    }

    return { kind: "and", terms };
}
