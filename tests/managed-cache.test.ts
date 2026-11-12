import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withTemporaryDirectory } from "../src/core/resources.js";
import { cachedAssembly } from "../src/methods/csharp/cache.js";

test("managed cache publishes runtime files without retaining source or intermediate builds", async () => {
    await withTemporaryDirectory(join(tmpdir(), "harness-managed-cache-"), async (directory) => {
        const target = join(directory, "owned");
        const assembly = await cachedAssembly(target, "Owned.dll", async (staging) => {
            await Bun.write(join(staging, "bin/Owned.dll"), "Compiled output");
            await Bun.write(join(staging, "bin/ref/Owned.dll"), "Public reference");
            await Bun.write(join(staging, "bin/compiler-inputs.txt"), "Required SDK inputs");
            await Bun.write(join(staging, "Method.cs"), "Original source");
            await Bun.write(join(staging, "obj/intermediate.dll"), "Intermediate output");
        });
        expect(await Bun.file(assembly).text()).toBe("Compiled output");
        expect(await Bun.file(join(target, "bin/ref/Owned.dll")).text()).toBe("Public reference");
        expect(await readdir(target)).toEqual(["bin"]);
        expect(
            await cachedAssembly(target, "Owned.dll", async () => {
                throw new Error("A published assembly must not rebuild.");
            }),
        ).toBe(assembly);
    });
});

test("a failed managed build leaves no published or temporary cache and can be retried", async () => {
    await withTemporaryDirectory(join(tmpdir(), "harness-managed-cache-"), async (directory) => {
        const target = join(directory, "owned");
        await expect(
            cachedAssembly(target, "Owned.dll", async (staging) => {
                await Bun.write(join(staging, "Method.cs"), "Incomplete build");

                throw new Error("Compilation rejected");
            }),
        ).rejects.toThrow("Compilation rejected");
        expect(await readdir(directory)).toEqual([]);

        const assembly = await cachedAssembly(target, "Owned.dll", async (staging) => {
            await Bun.write(join(staging, "bin/Owned.dll"), "Retried output");
        });
        expect(await Bun.file(assembly).text()).toBe("Retried output");
    });
});
