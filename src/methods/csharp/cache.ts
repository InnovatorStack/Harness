import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { withTemporaryDirectory } from "../../core/resources.js";

/** Publish complete builds atomically; another Bun process may share the same cache. */
export async function cachedAssembly(
    directory: string,
    filename: string,
    build: (staging: string) => Promise<void>,
): Promise<string> {
    await assertCacheDirectory(directory);
    const assembly = join(directory, "bin", filename);

    if (await Bun.file(assembly).exists()) {
        return assembly;
    }

    await mkdir(dirname(directory), { recursive: true });

    return await withTemporaryDirectory(`${directory}.build-`, async (staging) => {
        await build(staging);

        if (!(await Bun.file(join(staging, "bin", filename)).exists())) {
            throw new Error("The managed build succeeded without producing its assembly.");
        }

        for (const name of await readdir(staging)) {
            if (name !== "bin") {
                await rm(join(staging, name), { recursive: true, force: true });
            }
        }

        try {
            await rename(staging, directory);
        } catch (error) {
            if (!isPublishRace(error) || !(await Bun.file(assembly).exists())) {
                throw error;
            }
        }

        return assembly;
    });
}

async function assertCacheDirectory(directory: string): Promise<void> {
    try {
        const metadata = await stat(directory);

        if (!metadata.isDirectory()) {
            throw new Error("The managed cache destination must be a directory.");
        }
    } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
            throw error;
        }
    }
}

function isPublishRace(error: unknown): boolean {
    return (
        error instanceof Error &&
        "code" in error &&
        // Windows reports an existing, in-use destination directory as EPERM.
        (error.code === "EEXIST" || error.code === "ENOTEMPTY" || error.code === "EPERM")
    );
}
