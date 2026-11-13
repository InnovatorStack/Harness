import { cp, rm } from "node:fs/promises";
import { delimiter, join } from "node:path";

import { checkTypeScriptStyle } from "../style/typescript.js";

export async function runBun(
    arguments_: readonly string[],
    cwd: string,
    environment?: Readonly<Record<string, string | undefined>>,
): Promise<string> {
    const command = Bun.spawn([process.execPath, ...arguments_], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        ...(environment ? { env: environment } : {}),
    });
    const [exitCode, stdout, stderr] = await Promise.all([
        command.exited,
        new Response(command.stdout).text(),
        new Response(command.stderr).text(),
    ]);

    if (exitCode !== 0) {
        throw new Error(`Bun ${arguments_.join(" ")} failed:\n${stdout}\n${stderr}`);
    }

    return stdout + stderr;
}

export async function prepareConsumer(
    root: string,
    temporary: string,
    archive: string,
    name: string,
): Promise<string> {
    const directory = join(temporary, name);
    await cp(join(root, "examples", name), directory, {
        recursive: true,

        filter: (path) => !/[\\/](?:node_modules|cache|results)(?:[\\/]|$)/u.test(path),
    });
    await Bun.write(
        join(directory, "package.json"),
        JSON.stringify({
            name: `harness-release-${name}`,
            private: true,
            type: "module",
            devDependencies: {
                "@innovatorstack/harness": `file:${archive}`,
                "@types/bun": "^1.4.4",
            },
        }),
    );
    await runBun(["install"], directory);

    return directory;
}

export async function checkConsumer(root: string, directory: string): Promise<string> {
    await runBun([join(root, "node_modules/typescript/bin/tsc"), "--noEmit"], directory);
    await runBun(
        [
            "--bun",
            "run",
            join(root, "node_modules/oxfmt/bin/oxfmt"),
            "--config",
            join(root, "oxfmt.config.ts"),
            "--check",
            "tests",
            ".harness",
        ],
        directory,
    );
    const config = join(directory, "oxlint.config.mjs");
    const sharedConfig = Bun.pathToFileURL(join(root, "oxlint.config.ts")).href;
    const complexity = Bun.resolveSync("oxlint-plugin-complexity", root);
    await Bun.write(
        config,
        `
import configuration from ${JSON.stringify(sharedConfig)};

export default {
    ...configuration,
    jsPlugins: [${JSON.stringify(complexity)}],
};
`,
    );
    await runBun(
        [
            "--bun",
            "run",
            join(root, "node_modules/oxlint/bin/oxlint"),
            "--config",
            config,
            "--deny-warnings",
            "tests",
            ".harness",
        ],
        directory,
        {
            ...Bun.env,
            PATH: `${join(root, "node_modules/.bin")}${delimiter}${Bun.env.PATH ?? ""}`,
        },
    );
    const diagnostics = await checkTypeScriptStyle(directory);

    if (diagnostics.length > 0) {
        throw new Error(JSON.stringify(diagnostics, null, 2));
    }

    return await runBun(["test"], directory);
}

/** Execute the skill's maintained code examples against the same packed public API. */
export async function checkSkillExamples(root: string, directory: string): Promise<string> {
    const skill = await Bun.file(join(root, "skills/innovator-harness/SKILL.md")).text();
    const blocks = [...skill.matchAll(/```ts\n([\s\S]*?)```/gu)].map((match) => match[1]);

    if (blocks.length !== 2 || blocks[0] === undefined || blocks[1] === undefined) {
        throw new Error("The skill's fixture and test examples must both be checked.");
    }

    await rm(join(directory, "tests"), { recursive: true });
    await Bun.write(join(directory, ".harness/fixtures.ts"), blocks[0]);
    await Bun.write(join(directory, "tests/skill.test.ts"), blocks[1]);

    return await checkConsumer(root, directory);
}

export async function checkReadmeExamples(root: string, directory: string): Promise<string> {
    const results: string[] = [];

    for (const path of ["README.md", "docs/src/content/docs/index.md"]) {
        const document = await Bun.file(join(root, path)).text();
        const blocks = [...document.matchAll(/```ts\n([\s\S]*?)```/gu)].map((match) => match[1]);
        const fixtures = blocks.find((block) => block?.startsWith("// .harness/fixtures.ts\n"));
        const test = blocks.find((block) => block?.startsWith("// tests/solution.test.ts\n"));

        if (fixtures === undefined || test === undefined) {
            throw new Error(`${path} must include its checked fixture and test examples.`);
        }

        await rm(join(directory, "tests"), { recursive: true });
        await Bun.write(join(directory, ".harness/fixtures.ts"), fixtures);
        await Bun.write(join(directory, "tests/quickstart.test.ts"), test);
        results.push(`${path}\n${await checkConsumer(root, directory)}`);
    }

    return results.join("\n");
}
