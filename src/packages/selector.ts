import type { StorageValue } from "../storage/types.js";
import { PackageImportError } from "./diagnostics.js";
import type { AmlElement } from "./types.js";

export function matchesImportValue(
    actual: StorageValue | undefined,
    expected: StorageValue,
    name: string,
    dataType: string | undefined,
): boolean {
    if (actual === expected) {
        return true;
    }

    if (actual === undefined || actual === null || expected === null) {
        return false;
    }

    if (dataType === "integer" || dataType === "boolean" || dataType === "float") {
        const normalizedActual = String(actual).trim();
        const normalizedExpected = String(expected).trim();

        if (!normalizedActual || !normalizedExpected) {
            return false;
        }

        const actualNumber = Number(normalizedActual);
        const expectedNumber = Number(normalizedExpected);

        return (
            Number.isFinite(actualNumber) &&
            Number.isFinite(expectedNumber) &&
            actualNumber === expectedNumber
        );
    }

    if (name === "id" || dataType === "item") {
        return (
            typeof actual === "string" &&
            typeof expected === "string" &&
            actual.toLowerCase() === expected.toLowerCase()
        );
    }

    return false;
}

export interface EqualityFilter {
    readonly name: string;
    readonly value: string;
}

export function parseWhere(element: AmlElement): readonly EqualityFilter[] {
    const where = element.attributes.where;

    if (where === undefined) {
        return [];
    }

    const filters: EqualityFilter[] = [];
    let remaining = where.trim();

    while (remaining.length > 0) {
        const match = /^(?:\[([a-zA-Z_][\w]*)\]|([a-zA-Z_][\w]*))\s*=\s*'((?:[^']|'')*)'\s*/.exec(
            remaining,
        );

        if (!match) {
            break;
        }

        const name = match[1] ?? match[2];
        const value = match[3];

        if (!name || value === undefined) {
            break;
        }

        filters.push({ name, value: value.replaceAll("''", "'") });
        remaining = remaining.slice(match[0].length);

        if (remaining.length === 0) {
            return filters;
        }

        const conjunction = /^and\s+/i.exec(remaining);

        if (!conjunction) {
            break;
        }

        remaining = remaining.slice(conjunction[0].length);

        if (remaining.length === 0) {
            break;
        }
    }

    throw new PackageImportError(
        "UNSUPPORTED_SELECTOR",
        "Package selectors support equality to quoted strings joined with AND. Supply an explicit ID for other selectors.",
        element.source,
    );
}
