const outputBytesMax = 1_048_576;

/** Drain pipes while retaining bounded diagnostics; a full buffer must not deadlock the child. */
export async function readProcessOutput(
    stream: ReadableStream<Uint8Array>,
    signal?: AbortSignal,
): Promise<string> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    let bytes = 0;
    let truncated = false;
    const cancel = (): void => {
        void reader.cancel(signal?.reason).catch(() => {
            // The pipe may already be closed; the owner still receives the abort below.
        });
    };
    signal?.addEventListener("abort", cancel, { once: true });

    if (signal?.aborted) {
        cancel();
    }

    try {
        while (true) {
            const chunk = await reader.read();
            signal?.throwIfAborted();

            if (chunk.done) {
                break;
            }

            const available = outputBytesMax - bytes;
            const captured = chunk.value.subarray(0, Math.max(0, available));

            if (captured.length > 0) {
                chunks.push(decoder.decode(captured, { stream: true }));
            }

            bytes += captured.length;
            truncated ||= captured.length !== chunk.value.length;
        }

        chunks.push(decoder.decode());
    } finally {
        signal?.removeEventListener("abort", cancel);
        reader.releaseLock();
    }

    if (truncated) {
        chunks.push("\n[Build output truncated at the diagnostic byte limit.]\n");
    }

    return chunks.join("");
}
