import { dirname, resolve } from "node:path";

import { cloneData } from "../core/data.js";
import { errorMessage } from "../core/errors.js";
import { readJsonFile } from "../core/files.js";
import { setupFilesMax } from "../core/limits.js";
import { object } from "../items/codec.js";
import { validateParameters } from "./parameters.js";
import { MockRegistry, mockTarget } from "./registry.js";
import type { PreparedMock } from "./registry.js";
import { parseResponse, prepareResponse } from "./response.js";
import type { Mock, MockInput } from "./types.js";

export function mockInputs(value: unknown): readonly MockInput[] {
    if (!Array.isArray(value)) {
        throw new TypeError("Harness 'mocks' must be an array of definitions or JSON file paths.");
    }

    return value.map((entry, index) => {
        if (typeof entry === "string" && entry.trim()) {
            return entry;
        }

        return parseMock(entry, `mocks[${index}]`);
    });
}

export async function loadMocks(
    directory: string,
    shared: readonly MockInput[] | undefined,
    overrides: readonly MockInput[] | undefined,
): Promise<MockRegistry> {
    const prepared: PreparedMock[] = [];
    let inputs = shared;

    if (inputs === undefined) {
        const conventional = Bun.file(resolve(directory, "mocks.json"));

        if (await conventional.exists()) {
            inputs = ["./mocks.json"];
        }
    }

    // An explicit empty list clears shared mocks; otherwise local definitions override matching
    // calls.
    if (overrides?.length === 0) {
        return new MockRegistry([]);
    }

    await prepare(inputs ?? [], directory, 0, prepared);
    await prepare(overrides ?? [], directory, 1, prepared);

    return new MockRegistry(prepared);
}

async function prepare(
    inputs: readonly MockInput[],
    directory: string,
    layer: number,
    output: PreparedMock[],
): Promise<void> {
    for (const [index, input] of inputs.entries()) {
        if (typeof input === "string") {
            const file = resolve(directory, input);
            const value = await readJsonFile(file);

            if (!Array.isArray(value)) {
                throw new TypeError(`${file} must contain an array of mock definitions.`);
            }

            for (const [entry, candidate] of value.entries()) {
                await add(
                    parseMock(candidate, `${file}[${entry}]`),
                    dirname(file),
                    `${file}[${entry}]`,
                    layer,
                    output,
                );
            }
        } else {
            await add(
                input,
                directory,
                `configuration mocks[${index}] (layer ${layer})`,
                layer,
                output,
            );
        }
    }
}

async function add(
    mock: Mock,
    directory: string,
    definition: string,
    layer: number,
    output: PreparedMock[],
): Promise<void> {
    try {
        if (output.length >= setupFilesMax) {
            throw new Error("The mock definition limit was reached.");
        }

        output.push({
            ...mockTarget(mock),
            when: cloneData(mock.when ?? {}),
            response: await prepareResponse(mock.response, directory),
            definition,
            layer,
        });
    } catch (error) {
        throw new Error(`Cannot load mock ${definition}: ${errorMessage(error)}`, { cause: error });
    }
}

function parseMock(value: unknown, path: string): Mock {
    if (
        !object(value) ||
        !Object.keys(value).every((key) => ["method", "sql", "when", "response"].includes(key))
    ) {
        throw new Error(`${path} must contain method or sql, optional when, and response.`);
    }

    if (!("response" in value)) {
        throw new Error(`${path} is missing response.`);
    }

    const method = typeof value.method === "string" && value.method.trim().length > 0;
    const sql =
        value.sql === true || (typeof value.sql === "string" && value.sql.trim().length > 0);

    if (
        (method ? 1 : 0) + (sql ? 1 : 0) !== 1 ||
        (method && "sql" in value) ||
        (sql && "method" in value)
    ) {
        throw new Error(`${path} must select exactly one method or sql target.`);
    }

    const response = parseResponse(value.response);
    const when = value.when;

    if (when !== undefined) {
        validateParameters(when, `${path}.when`);
    }

    const options = { response, ...(when === undefined ? {} : { when }) };

    if (typeof value.method === "string") {
        return { method: value.method, ...options };
    }

    if (value.sql === true || typeof value.sql === "string") {
        return { sql: value.sql, ...options };
    }

    throw new Error(`${path} has no mock target.`);
}
