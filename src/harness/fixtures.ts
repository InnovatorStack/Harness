import { lstat, readdir, realpath } from "node:fs/promises";
import { extname, join } from "node:path";

import { assertDataTree, setOwn, getOwn } from "../core/data.js";
import { setupFilesMax, setupBytesMax } from "../core/limits.js";
import type { Engine } from "../engine.js";
import { loadFixtureRecords } from "../fixtures/module.js";
import type { FixtureRecord, Fixtures, FixtureValue } from "../fixtures/types.js";
import { loadSetupModule } from "./setup-module.js";

export async function splitFixturePaths(paths: readonly string[]): Promise<{
    readonly aml: readonly string[];
    readonly typescript: readonly string[];
}> {
    const aml: string[] = [];
    const typescript: string[] = [];
    const seen = new Set<string>();

    const pending = [...paths].reverse();
    let visited = 0;

    while (pending.length > 0) {
        visited += 1;

        if (visited > setupFilesMax || pending.length > setupFilesMax) {
            throw new Error("Fixture discovery exceeded its file limit.");
        }

        const path = pending.pop();

        if (path === undefined) {
            throw new Error("A fixture path must exist while discovery is pending.");
        }

        const status = await lstat(path);

        if (status.isSymbolicLink()) {
            throw new Error(`Fixture input '${path}' is a symbolic link. Supply its real path.`);
        }

        if (status.isDirectory()) {
            const entries = await readdir(path);

            for (const entry of entries.sort().reverse()) {
                pending.push(join(path, entry));
            }

            continue;
        }

        const canonical = await realpath(path);

        if (seen.has(canonical)) {
            throw new Error(`Fixture input '${path}' was supplied more than once.`);
        }

        seen.add(canonical);

        if (extname(path) === ".ts") {
            typescript.push(canonical);
        } else if (extname(path).toLowerCase() === ".xml") {
            aml.push(canonical);
        } else {
            throw new Error(
                `Unsupported fixture '${path}'. Use a TypeScript data module or AML XML.`,
            );
        }
    }

    return { aml, typescript };
}

export async function loadTypeScriptFixtures(
    engine: Engine,
    paths: readonly string[],
): Promise<void> {
    const records = await readTypeScriptFixtures(paths);

    if (paths.length > 0) {
        engine.runtime.executeSync(loadFixtureRecords, records);
    }
}

export async function readTypeScriptFixtures(paths: readonly string[]): Promise<Fixtures> {
    const combined: Record<string, FixtureRecord[]> = {};
    let bytes = 0;

    for (const path of paths) {
        const imported = await loadSetupModule(path);

        if (!isObject(imported)) {
            throw new Error(`Cannot read fixture module '${path}'.`);
        }

        assertDataTree(imported.default, { allowArrays: true, allowUndefined: false });
        bytes += JSON.stringify(imported.default).length * 3;

        if (bytes > setupBytesMax) {
            throw new Error("Combined fixture data exceeds its byte limit.");
        }

        const fixtures = parseFixtures(imported.default, path);

        for (const [type, records] of Object.entries(fixtures)) {
            const existing = Object.hasOwn(combined, type) ? getOwn(combined, type) : undefined;

            if (existing) {
                for (const record of records) {
                    existing.push(record);
                }
            } else {
                setOwn(combined, type, [...records]);
            }
        }
    }

    return combined;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFixtures(value: unknown, path: string): Fixtures {
    if (!isObject(value)) {
        throw new Error(`${path} must default-export fixture records grouped by ItemType.`);
    }

    const fixtures: Record<string, FixtureRecord[]> = {};

    for (const [type, records] of Object.entries(value)) {
        if (!Array.isArray(records)) {
            throw new TypeError(`Fixture '${type}' in ${path} must be an array of records.`);
        }

        setOwn(
            fixtures,
            type,
            records.map((record) => parseRecord(record, path, type)),
        );
    }

    return fixtures;
}

function parseRecord(value: unknown, path: string, type: string): FixtureRecord {
    if (!isObject(value)) {
        throw new Error(`Fixture '${type}' in ${path} contains an invalid record.`);
    }

    const record: Record<string, FixtureValue> = {};

    for (const [name, property] of Object.entries(value)) {
        if (isObject(property)) {
            const selector: Record<string, string | number | null> = {};

            for (const [key, entry] of Object.entries(property)) {
                if (!isScalar(entry)) {
                    throw new Error(
                        `Invalid fixture selector '${type}.${name}.${key}' in ${path}.`,
                    );
                }

                setOwn(selector, key, entry);
            }

            setOwn(record, name, selector);
        } else {
            if (!isScalar(property)) {
                throw new Error(`Invalid fixture value '${type}.${name}' in ${path}.`);
            }

            setOwn(record, name, property);
        }
    }

    return record;
}

function isScalar(value: unknown): value is string | number | null {
    return (
        value === null ||
        typeof value === "string" ||
        (typeof value === "number" && Number.isFinite(value))
    );
}
