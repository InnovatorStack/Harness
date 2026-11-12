import { assertDataTree, parseFrozenJson } from "../../core/data.js";
import { object } from "../../items/codec.js";
import { PlatformError } from "../../platform/errors.js";

export const messageBytesMax = 8 * 1024 * 1024;
export const pendingCallsMax = 128;
const encoder = new TextEncoder();

export function encodeMessage(message: unknown): Uint8Array {
    assertDataTree(message);
    const bytes = encoder.encode(`${JSON.stringify(message)}\n`);

    if (bytes.length > messageBytesMax) {
        throw new PlatformError("ProtocolLimit", "C# message exceeds the 8 MiB limit.");
    }

    return bytes;
}

/** The byte budget applies to each frame, including when one pipe chunk contains many frames. */
export async function readMessages(
    stream: ReadableStream<Uint8Array>,
    receive: (message: Record<string, unknown>) => void,
    readWhenActive?: () => Promise<boolean>,
): Promise<void> {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let buffer = "";

    while (true) {
        if (readWhenActive && !(await readWhenActive())) {
            break;
        }

        const chunk = await readChunk(stream);

        if (chunk.done) {
            buffer += decoder.decode();
            break;
        }

        buffer += decoder.decode(chunk.value, { stream: true });
        let newline = buffer.indexOf("\n");

        while (newline >= 0) {
            const line = buffer.slice(0, newline);
            assertMessageSize(line);
            const message = parseFrozenJson(line);

            if (
                !object(message) ||
                typeof message.kind !== "string" ||
                typeof message.id !== "string"
            ) {
                throw new PlatformError("InvalidProtocol", "Invalid C# worker message.");
            }

            receive(message);
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf("\n");
        }

        assertMessageSize(buffer);
    }

    if (buffer.length > 0) {
        throw new PlatformError("InvalidProtocol", "C# worker stopped inside a message.");
    }
}

/** Releasing Bun's pipe reader between frames lets an idle, unreferenced worker exit cleanly. */
async function readChunk(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader();

    try {
        return await reader.read();
    } finally {
        reader.releaseLock();
    }
}

function assertMessageSize(value: string): void {
    if (value.length > messageBytesMax || encoder.encode(value).length > messageBytesMax) {
        throw new PlatformError("ProtocolLimit", "C# worker message exceeds the 8 MiB limit.");
    }
}
