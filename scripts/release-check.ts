import { cp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withTemporaryDirectory } from "../src/core/resources.js";
import { auditDistribution } from "./release/audit.js";
import {
    runBun,
    prepareConsumer,
    checkConsumer,
    checkSkillExamples,
    checkReadmeExamples,
} from "./release/consumers.js";
import { auditRepository } from "./release/repository.js";

const root = Bun.fileURLToPath(new URL("..", import.meta.url));
const sourceFiles = await auditRepository(root);
const output = join(root, "tests/results/release");
await rm(output, { recursive: true, force: true });
await runBun(["run", "build"], root);
const report = await withTemporaryDirectory(join(tmpdir(), "harness-release-"), async (created) => {
    const temporary = await realpath(created);
    await runBun(["pm", "pack", "--destination", temporary], root);
    const names = [...new Bun.Glob("*.tgz").scanSync({ cwd: temporary })];
    const name = names[0];

    if (names.length !== 1 || name === undefined) {
        throw new Error("Packing must produce exactly one release archive.");
    }

    const archive = join(temporary, name);
    const files = await new Bun.Archive(await Bun.file(archive).arrayBuffer()).files();
    const sourceMaps = await auditDistribution(files);
    const results: Record<string, string> = {};

    for (const example of ["basic", "server-methods"]) {
        const consumer = await prepareConsumer(root, temporary, archive, example);
        results[example] = await checkConsumer(root, consumer);

        if (example === "server-methods") {
            results.skill = await checkSkillExamples(root, consumer);
        } else {
            results.quickstart = await checkReadmeExamples(root, consumer);
        }
    }

    await mkdir(output, { recursive: true });
    await cp(archive, join(output, name));

    return {
        generatedAt: new Date().toISOString(),
        sourceFiles,
        files: files.size,
        sourceMaps,
        archive: name,
        sha256: new Bun.CryptoHasher("sha256")
            .update(await Bun.file(archive).arrayBuffer())
            .digest("hex"),
        results,
    };
});
await mkdir(join(root, "tests/results"), { recursive: true });
await Bun.write(join(root, "tests/results/release.json"), JSON.stringify(report, null, 2));

for (const [name, result] of Object.entries(report.results)) {
    console.log(`${name}\n${result}`);
}

console.log(`Audited ${report.files} published files; release consumers passed.`);
