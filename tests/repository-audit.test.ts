import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { auditRepository } from "../scripts/release/repository.js";
import { withTemporaryDirectory } from "../src/core/resources.js";

async function git(directory: string, arguments_: readonly string[]): Promise<void> {
    const command = Bun.spawn(["git", ...arguments_], {
        cwd: directory,
        stdout: "ignore",
        stderr: "ignore",
    });

    if ((await command.exited) !== 0) {
        throw new Error("Cannot construct the isolated repository audit case.");
    }
}

test("repository review excludes local files but rejects an ignored file staged for publication", async () => {
    await withTemporaryDirectory(join(tmpdir(), "harness-source-audit-"), async (directory) => {
        await git(directory, ["init", "--quiet"]);
        await Bun.write(join(directory, ".gitignore"), "workspaces/\n");
        await Bun.write(join(directory, "source.ts"), "export {};\n");
        await Bun.write(join(directory, "workspaces/capture.xml"), "<private />");
        expect(await auditRepository(directory)).toBe(2);

        await git(directory, ["add", "--force", "workspaces/capture.xml"]);
        await expect(auditRepository(directory)).rejects.toThrow("private or generated file");
    });
});
