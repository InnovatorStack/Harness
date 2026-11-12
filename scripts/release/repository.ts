import { lstat } from "node:fs/promises";
import { join } from "node:path";

import { assertPublicText } from "./audit.js";

const sourceFilesMax = 20_000;
const sourceBytesMax = 64 * 1024 * 1024;
const privatePath = /(?:^|\/)(?:workspaces|node_modules|results|captures|cache)(?:\/|$)/u;

/** Include staged files even if an ignore rule would otherwise conceal them. */
export async function auditRepository(root: string): Promise<number> {
    const git = Bun.spawn(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
    });
    const [exitCode, output] = await Promise.all([
        git.exited,
        new Response(git.stdout).text(),
        new Response(git.stderr).text(),
    ]);

    if (exitCode !== 0) {
        throw new Error("Cannot inspect the public repository file list.");
    }

    const paths = [...new Set(output.split("\0").filter(Boolean))];

    if (paths.length > sourceFilesMax) {
        throw new Error("The repository exceeds its source-review file limit.");
    }

    let bytes = 0;

    for (const path of paths) {
        if (privatePath.test(path) || /\.(?:sqlite|tgz|bak|log)$/iu.test(path)) {
            throw new Error(`A private or generated file would be public: '${path}'.`);
        }

        const absolute = join(root, path);
        const metadata = await lstat(absolute);

        if (!metadata.isFile() || metadata.isSymbolicLink()) {
            throw new Error(`Review non-file repository entry '${path}' before publishing.`);
        }

        bytes += metadata.size;

        if (bytes > sourceBytesMax) {
            throw new Error("The repository exceeds its source-review byte limit.");
        }

        assertPublicText(path, await Bun.file(absolute).text());
    }

    return paths.length;
}
