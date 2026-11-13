import { resolve } from "node:path";

import { setOwn } from "../core/data.js";
import { readTextFile } from "../core/files.js";
import { setupBytesMax, setupFilesMax } from "../core/limits.js";
import type { MethodFile } from "../methods/sources.js";

export function methodMappings(value: unknown): Readonly<Record<string, string>> | undefined {
    if (value === undefined) {
        return undefined;
    }

    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TypeError("Harness methods must map Method names to source file paths.");
    }

    if (
        Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null
    ) {
        throw new TypeError("Harness methods must be a plain object of source file paths.");
    }

    const mappings: Record<string, string> = {};
    const names = new Set<string>();
    const entries = Object.entries(value);

    if (entries.length > setupFilesMax) {
        throw new TypeError("Harness methods exceed the setup file limit.");
    }

    for (const [name, path] of entries) {
        if (name.trim().length === 0 || typeof path !== "string" || path.trim().length === 0) {
            throw new TypeError("Harness methods require nonempty Method names and file paths.");
        }

        if (names.has(name.toLowerCase())) {
            throw new TypeError(`Duplicate Method source mapping '${name}'.`);
        }

        names.add(name.toLowerCase());
        setOwn(mappings, name, path);
    }

    return Object.freeze(mappings);
}

/** Per-world mappings override matching names; an explicit empty map clears shared mappings. */
export function mergeMethodMappings(
    shared: Readonly<Record<string, string>> | undefined,
    value: unknown,
): Readonly<Record<string, string>> | undefined {
    const overrides = methodMappings(value);

    if (overrides === undefined || Object.keys(overrides).length === 0) {
        return overrides ?? shared;
    }

    const entries = new Map<string, readonly [string, string]>();

    for (const [name, path] of Object.entries(shared ?? {})) {
        entries.set(name.toLowerCase(), [name, path]);
    }

    for (const [name, path] of Object.entries(overrides)) {
        entries.set(name.toLowerCase(), [name, path]);
    }

    return Object.freeze(Object.fromEntries(entries.values()));
}

export async function readMethodFiles(
    directory: string,
    mappings: Readonly<Record<string, string>> | undefined,
): Promise<readonly MethodFile[]> {
    const files: MethodFile[] = [];
    let bytes = 0;

    for (const [name, path] of Object.entries(mappings ?? {})) {
        const file = await readMethodFile(name, resolve(directory, path));

        if ("code" in file) {
            bytes += file.code.length * 3;

            if (bytes > setupBytesMax) {
                throw new TypeError("Mapped Method sources exceed the setup byte limit.");
            }
        }

        files.push(file);
    }

    return Object.freeze(files);
}

async function readMethodFile(name: string, file: string): Promise<MethodFile> {
    try {
        return Object.freeze({ name, file, code: await readTextFile(file) });
    } catch (error) {
        if (
            error instanceof Error &&
            "code" in error &&
            (error.code === "ENOENT" || error.code === "ENOTDIR")
        ) {
            return Object.freeze({ name, file, missing: true });
        }

        if (!(error instanceof Error)) {
            throw error;
        }

        return Object.freeze({ name, file, error });
    }
}
