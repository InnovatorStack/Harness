import type { ReadableStreamDefaultReader } from "node:stream/web";

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
    readWhenActive?: () => boolean | Promise<boolean>,
): Promise<void> {
    const decoder = new MessageDecoder();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    try {
        while (true) {
            const active = readWhenActive?.() ?? true;

            if (typeof active !== "boolean") {
                reader?.releaseLock();
                reader = undefined;

                if (!(await active)) {
                    break;
                }
            } else if (!active) {
                break;
            }

            reader ??= stream.getReader();
            const chunk = await reader.read();

            if (chunk.done) {
                break;
            }

            decoder.push(chunk.value, receive);
        }

        decoder.finish();
    } finally {
        reader?.releaseLock();
    }
}

class MessageDecoder {
    private readonly decoder = new TextDecoder("utf-8", { fatal: true });
    private buffer = "";

    push(bytes: Uint8Array, receive: (message: Record<string, unknown>) => void): void {
        this.buffer += this.decoder.decode(bytes, { stream: true });
        let newline = this.buffer.indexOf("\n");

        while (newline >= 0) {
            const line = this.buffer.slice(0, newline);
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
            this.buffer = this.buffer.slice(newline + 1);
            newline = this.buffer.indexOf("\n");
        }

        assertMessageSize(this.buffer);
    }

    finish(): void {
        this.buffer += this.decoder.decode();

        if (this.buffer.length > 0) {
            throw new PlatformError("InvalidProtocol", "C# worker stopped inside a message.");
        }
    }
}

function assertMessageSize(value: string): void {
    if (value.length > messageBytesMax || encoder.encode(value).length > messageBytesMax) {
        throw new PlatformError("ProtocolLimit", "C# worker message exceeds the 8 MiB limit.");
    }
}
