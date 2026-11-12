import { mkdtemp, rm } from "node:fs/promises";

/** Preserve both failures when temporary work and filesystem cleanup fail together. */
export async function withTemporaryDirectory<Value>(
    prefix: string,
    work: (directory: string) => Promise<Value>,
): Promise<Value> {
    const directory = await mkdtemp(prefix);
    let outcome: { ok: true; value: Value } | { ok: false; error: unknown };

    try {
        outcome = { ok: true, value: await work(directory) };
    } catch (error) {
        outcome = { ok: false, error };
    }

    try {
        await rm(directory, { recursive: true, force: true });
    } catch (error) {
        if (!outcome.ok) {
            throw new AggregateError([outcome.error, error], "Work and cleanup failed.", {
                cause: error,
            });
        }

        throw error;
    }

    if (!outcome.ok) {
        throw outcome.error;
    }

    return outcome.value;
}
