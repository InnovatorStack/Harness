import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquireWorker, releaseWorker } from "../src/methods/csharp/worker.js";
import type { ManagedWorker } from "../src/methods/csharp/worker.js";

test("a failed idle reset retires its process before the next owner attaches", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-worker-recovery-"));
    const host = join(directory, "exit-on-reset.ts");
    const bun = Bun.which("bun") ?? "bun";
    let original: ManagedWorker | undefined;
    let replacement: ManagedWorker | undefined;

    try {
        await Bun.write(host, "await Bun.stdin.stream().getReader().read(); process.exit(7);");
        original = await acquireWorker(bun, host, []);
        releaseWorker(JSON.stringify([bun, host, []]), original);
        replacement = await acquireWorker(bun, host, []);

        expect(replacement).not.toBe(original);
        expect(await original.process.exited).toBe(7);
        expect(original.available).toBe(false);
        expect(replacement.available).toBe(true);
    } finally {
        original?.close();
        replacement?.close();
        await Promise.all([original?.process.exited, replacement?.process.exited]);
        await rm(directory, { recursive: true, force: true });
    }
}, 10_000);
