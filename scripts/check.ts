import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const root = Bun.fileURLToPath(new URL("..", import.meta.url));
const results = join(root, "tests/results");

const checks = [
    { name: "Formatting", arguments: ["run", "format:check"] },
    { name: "Lint", arguments: ["run", "lint"] },
    { name: "Types", arguments: ["run", "typecheck"] },
    {
        name: "Tests",
        arguments: [
            "test",
            "--parallel=4",
            "--reporter=junit",
            "--reporter-outfile=tests/results/tests.xml",
        ],
    },
    { name: "Build", arguments: ["run", "build"] },
];

interface CheckResult {
    readonly name: string;
    readonly status: "passed" | "failed";
    readonly exitCode: number;
}

await rm(results, { recursive: true, force: true });
await mkdir(results, { recursive: true });

const completed: CheckResult[] = [];

for (const check of checks) {
    const command = Bun.spawn([process.execPath, ...check.arguments], {
        cwd: root,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
    });
    const exitCode = await command.exited;
    completed.push({ name: check.name, status: exitCode === 0 ? "passed" : "failed", exitCode });

    if (exitCode !== 0) {
        process.exitCode = exitCode;
        break;
    }
}

const passed =
    completed.length === checks.length && completed.every((check) => check.status === "passed");
const report = {
    generatedAt: new Date().toISOString(),
    status: passed ? "passed" : "failed",
    checks: completed,
};

await Bun.write(join(results, "check.json"), JSON.stringify(report, null, 2));
await Bun.write(
    join(results, "README.md"),
    [
        "# Framework verification",
        "",
        `Result: **${report.status}**. Completed ${report.generatedAt}.`,
        "",
        "| Check | Result |",
        "| --- | --- |",
        ...completed.map((check) => `| ${check.name} | ${check.status} |`),
        "",
        "[Test results](./tests.xml) · [Check details](./check.json)",
        "",
    ].join("\n"),
);

console.log(`\nFramework results: ${join(results, "README.md")}`);
