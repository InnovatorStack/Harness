import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { readBinaryFile } from "../core/files.js";
import type { EngineImage } from "../engine/instance.js";

const imageBytesMax = 64 * 1024 * 1024;
const metadataBytesMax = 4096;
const headerBytes = 12;
const signature = new TextEncoder().encode("IHSETUP1");

/** One replaceable artifact per project, shared by all test cases and Bun invocations. */
export async function readSetupImage(path: string, key: string): Promise<EngineImage | undefined> {
    try {
        const bytes = await readBinaryFile(path, imageBytesMax + metadataBytesMax + headerBytes);

        return decodeImage(bytes, key);
    } catch (error) {
        if (unavailable(error) || error instanceof SyntaxError || error instanceof TypeError) {
            return undefined;
        }

        throw error;
    }
}

function decodeImage(bytes: Uint8Array, key: string): EngineImage | undefined {
    if (bytes.length < headerBytes || !signature.every((value, index) => bytes[index] === value)) {
        return undefined;
    }

    const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
        8,
        true,
    );

    if (length > metadataBytesMax || headerBytes + length >= bytes.length) {
        return undefined;
    }

    const parsed: unknown = JSON.parse(
        new TextDecoder().decode(bytes.subarray(headerBytes, headerBytes + length)),
    );

    if (
        !record(parsed) ||
        parsed.key !== key ||
        !record(parsed.values) ||
        !record(parsed.values.ids)
    ) {
        return undefined;
    }

    const clock = parsed.values.clock;
    const fixtures = parsed.values.ids.fixtures;
    const items = parsed.values.ids.items;

    if (
        (clock !== undefined && (typeof clock !== "number" || !Number.isFinite(clock))) ||
        !counter(fixtures) ||
        !counter(items)
    ) {
        return undefined;
    }

    const database = bytes.subarray(headerBytes + length);

    if (
        database.length > imageBytesMax ||
        new Bun.CryptoHasher("sha256")
            .update(JSON.stringify({ key: parsed.key, values: parsed.values }))
            .update(database)
            .digest("hex") !== parsed.hash
    ) {
        return undefined;
    }

    return { database, values: { clock, ids: { fixtures, items } } };
}

export async function writeSetupImage(
    path: string,
    key: string,
    image: EngineImage,
): Promise<void> {
    if (image.database.byteLength > imageBytesMax) {
        return;
    }

    const metadata = new TextEncoder().encode(
        JSON.stringify({
            key,
            hash: new Bun.CryptoHasher("sha256")
                .update(JSON.stringify({ key, values: image.values }))
                .update(image.database)
                .digest("hex"),
            values: image.values,
        }),
    );
    const bytes = new Uint8Array(headerBytes + metadata.length + image.database.byteLength);
    bytes.set(signature);
    new DataView(bytes.buffer).setUint32(8, metadata.length, true);
    bytes.set(metadata, headerBytes);
    bytes.set(image.database, headerBytes + metadata.length);
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;

    try {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await ignoreCache(dirname(path));
        await Bun.write(temporary, bytes, { mode: 0o600 });
        await rename(temporary, path);
    } catch (error) {
        if (!unavailable(error)) {
            throw error;
        }
    } finally {
        await removeTemporaryImage(temporary);
    }
}

async function removeTemporaryImage(path: string): Promise<void> {
    try {
        await rm(path, { force: true });
    } catch (error) {
        if (!unavailable(error)) {
            throw error;
        }
    }
}

async function ignoreCache(directory: string): Promise<void> {
    try {
        await writeFile(join(directory, ".gitignore"), "*\n", { flag: "wx", mode: 0o600 });
    } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
            throw error;
        }
    }
}

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function counter(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function unavailable(error: unknown): boolean {
    return (
        error instanceof Error &&
        "code" in error &&
        ["ENOENT", "EACCES", "EPERM", "EROFS", "ENOSPC", "ENOTDIR"].includes(String(error.code))
    );
}
