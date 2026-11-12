import { parseFrozenJson } from "../../core/data.js";
import { dataBytesMax } from "../../core/limits.js";
import type { SourceLocation } from "../../diagnostics/source-location.js";
import type { ItemTypeDefinition, PropertyDefinition, StorageValue } from "../types.js";
import { StorageError } from "./errors.js";

const definitions = new Map<string, ItemTypeDefinition>();
const definitionCacheEntriesMax = 512;
const definitionCacheBytesMax = 4 * 1024 * 1024;
let definitionCacheBytes = 0;
const presences = new Map<string, readonly string[]>();
const presenceCacheEntriesMax = 128;
const presenceTextBytesMax = 16 * 1024;

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function source(value: unknown): value is SourceLocation {
    return (
        record(value) &&
        typeof value.file === "string" &&
        typeof value.line === "number" &&
        typeof value.column === "number" &&
        typeof value.path === "string"
    );
}

function property(value: unknown): value is PropertyDefinition {
    return (
        record(value) &&
        typeof value.name === "string" &&
        typeof value.dataType === "string" &&
        (value.id === undefined || typeof value.id === "string") &&
        (value.dataSource === undefined || typeof value.dataSource === "string") &&
        (value.foreignProperty === undefined || typeof value.foreignProperty === "string") &&
        (value.isFederated === undefined || typeof value.isFederated === "boolean") &&
        (value.isRequired === undefined || typeof value.isRequired === "boolean") &&
        (value.defaultValue === undefined ||
            value.defaultValue === null ||
            typeof value.defaultValue === "string" ||
            (typeof value.defaultValue === "number" && Number.isFinite(value.defaultValue))) &&
        (value.source === undefined || source(value.source))
    );
}

function definition(value: unknown): value is ItemTypeDefinition {
    return (
        record(value) &&
        typeof value.id === "string" &&
        typeof value.name === "string" &&
        (value.tableName === undefined || typeof value.tableName === "string") &&
        (value.isRelationship === undefined || typeof value.isRelationship === "boolean") &&
        (value.isVersionable === undefined || typeof value.isVersionable === "boolean") &&
        Array.isArray(value.properties) &&
        value.properties.every(property) &&
        (value.source === undefined || source(value.source))
    );
}

function parse(text: string): unknown {
    try {
        if (text.length > dataBytesMax) {
            throw new TypeError("Stored metadata exceeds its text limit.");
        }

        return parseFrozenJson(text);
    } catch (error) {
        throw new StorageError("CORRUPT_STORAGE", "Stored metadata is not valid JSON.", {
            cause: error,
        });
    }
}

export function decodeDefinition(text: string): ItemTypeDefinition {
    const cached = definitions.get(text);

    if (cached) {
        definitions.delete(text);
        definitions.set(text, cached);

        return cached;
    }

    const value = parse(text);

    if (!definition(value)) {
        throw new StorageError("CORRUPT_STORAGE", "Stored ItemType metadata has an invalid shape.");
    }

    const bytes = text.length * 3;

    if (bytes <= definitionCacheBytesMax) {
        while (
            definitions.size >= definitionCacheEntriesMax ||
            definitionCacheBytes + bytes > definitionCacheBytesMax
        ) {
            const oldest = definitions.keys().next().value;

            if (oldest === undefined) {
                throw new Error("Definition cache eviction requires an existing entry.");
            }

            definitions.delete(oldest);
            definitionCacheBytes -= oldest.length * 3;
        }

        definitions.set(text, value);
        definitionCacheBytes += bytes;
    }

    return value;
}

export function decodeProperties(text: string): Record<string, StorageValue> {
    const value = parse(text);

    if (
        !record(value) ||
        !Object.values(value).every(
            (entry) =>
                entry === null ||
                typeof entry === "string" ||
                (typeof entry === "number" && Number.isFinite(entry)),
        )
    ) {
        throw new StorageError(
            "CORRUPT_STORAGE",
            "Stored catalog properties have an invalid shape.",
        );
    }

    const result: Record<string, StorageValue> = {};

    for (const [key, entry] of Object.entries(value)) {
        if (entry === null || typeof entry === "string" || typeof entry === "number") {
            Object.defineProperty(result, key, {
                value: entry,
                enumerable: true,
                configurable: true,
                writable: true,
            });
        }
    }

    return result;
}

export function decodeAttributes(text: string): Record<string, string> {
    const value = parse(text);

    if (!record(value) || !Object.values(value).every((entry) => typeof entry === "string")) {
        throw new StorageError("CORRUPT_STORAGE", "Stored attributes have an invalid shape.");
    }

    const result: Record<string, string> = {};

    for (const [key, entry] of Object.entries(value)) {
        if (typeof entry === "string") {
            Object.defineProperty(result, key, {
                value: entry,
                enumerable: true,
                configurable: true,
                writable: true,
            });
        }
    }

    return result;
}

export function decodeSource(text: string): SourceLocation {
    const value = parse(text);

    if (!source(value)) {
        throw new StorageError("CORRUPT_STORAGE", "Stored source location has an invalid shape.");
    }

    return value;
}

export function decodePresentProperties(text: string): readonly string[] {
    const cached = presences.get(text);

    if (cached) {
        presences.delete(text);
        presences.set(text, cached);

        return cached;
    }

    const value = parse(text);

    if (
        !Array.isArray(value) ||
        !value.every((entry): entry is string => typeof entry === "string")
    ) {
        throw new StorageError("CORRUPT_STORAGE", "Stored property presence has an invalid shape.");
    }

    if (text.length * 3 <= presenceTextBytesMax) {
        if (presences.size >= presenceCacheEntriesMax) {
            const oldest = presences.keys().next().value;

            if (oldest === undefined) {
                throw new Error("Presence cache eviction requires an existing entry.");
            }

            presences.delete(oldest);
        }

        presences.set(text, value);
    }

    return value;
}
