import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import manifest from "../package.json";
import { withTemporaryDirectory } from "../src/core/resources.js";

test("source packaging includes debugger inputs without managed intermediates", async () => {
    await withTemporaryDirectory(join(tmpdir(), "harness-assets-"), async (directory) => {
        await Bun.write(
            join(directory, "package.json"),
            JSON.stringify({
                name: "harness-assets-test",
                version: "0.0.0",
                files: manifest.files,
            }),
        );
        await Bun.write(join(directory, "src/index.ts"), "export {};\n");
        await Bun.write(join(directory, "src/baseline/data/records.json"), "{}");
        await Bun.write(
            join(directory, "src/methods/csharp/managed/obj/project.assets.json"),
            "{}",
        );
        await Bun.write(join(directory, "src/methods/csharp/managed/bin/Local.dll"), "local");
        const command = Bun.spawn([process.execPath, "pm", "pack"], {
            cwd: directory,
            stdout: "pipe",
            stderr: "pipe",
        });
        const [exitCode, stdout, stderr] = await Promise.all([
            command.exited,
            new Response(command.stdout).text(),
            new Response(command.stderr).text(),
        ]);

        if (exitCode !== 0) {
            throw new Error(`Cannot pack the isolated asset case:\n${stdout}\n${stderr}`);
        }

        const archive = Bun.file(join(directory, "harness-assets-test-0.0.0.tgz"));
        const files = await new Bun.Archive(await archive.arrayBuffer()).files();
        expect([...files.keys()].sort((left, right) => left.localeCompare(right))).toEqual([
            "package/package.json",
            "package/src/baseline/data/records.json",
            "package/src/index.ts",
        ]);
    });
});
