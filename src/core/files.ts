import { Deadline } from "./deadline.js";
import { dataBytesMax } from "./limits.js";

export class TextEncodingError extends TypeError {
    override readonly name = "TextEncodingError";
}

/** Read a bounded slice even if the file grows between discovery and the actual read. */
export async function readTextFile(path: string, bytesMax = dataBytesMax): Promise<string> {
    const bytes = await readBinaryFile(path, bytesMax);

    try {
        return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch (error) {
        throw new TextEncodingError(`File '${path}' is not valid UTF-8.`, { cause: error });
    }
}

export async function readBinaryFile(path: string, bytesMax = dataBytesMax): Promise<Uint8Array> {
    if (!Number.isSafeInteger(bytesMax) || bytesMax < 1) {
        throw new TypeError("A file byte limit must be a positive safe integer.");
    }

    using deadline = new Deadline(30_000, () => new Error(`Reading '${path}' timed out.`));
    const file = Bun.file(path);
    const status = await deadline.wait(file.stat());

    if (!status.isFile()) {
        throw new TypeError(`Input '${path}' must be a regular file.`);
    }

    const bytes = await deadline.wait(file.slice(0, bytesMax + 1).bytes());

    if (bytes.length > bytesMax) {
        throw new TypeError(`File '${path}' exceeds the ${bytesMax}-byte input limit.`);
    }

    return bytes;
}

export async function readJsonFile(path: string): Promise<unknown> {
    const text = await readTextFile(path);

    return JSON.parse(text.replace(/^\uFEFF/u, ""));
}
