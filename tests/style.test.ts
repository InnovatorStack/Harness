import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { checkTypeScriptStyle } from "../scripts/style/typescript.js";

const directory = Bun.fileURLToPath(new URL("..", import.meta.url));
const temporaryDirectories: string[] = [];

async function project(files: Readonly<Record<string, string>>): Promise<string> {
    const temporary = await mkdtemp(join(tmpdir(), "harness-style-test-"));
    temporaryDirectories.push(temporary);
    await Bun.write(
        join(temporary, "tsconfig.json"),
        JSON.stringify({
            compilerOptions: { strict: true, target: "ES2022" },
            include: ["**/*.ts", ".harness/**/*.ts"],
        }),
    );

    for (const [name, source] of Object.entries(files)) {
        const path = join(temporary, name);
        await mkdir(dirname(path), { recursive: true });
        await Bun.write(path, source);
    }

    return temporary;
}

afterEach(async () => {
    for (const temporary of temporaryDirectories.splice(0)) {
        await rm(temporary, { recursive: true, force: true });
    }
});

test("the function limit covers library, test, script and setup files", async () => {
    const longFunction = `export function example() {\n${"    void 0;\n".repeat(69)}}\n`;
    const files = {
        "src/nested/example.ts": longFunction,
        "tests/example.test.ts": longFunction,
        "scripts/example.ts": longFunction,
        ".harness/config.ts": longFunction,
    };
    const temporary = await project(files);
    const diagnostics = await checkTypeScriptStyle(temporary);
    expect(diagnostics.map((diagnostic) => diagnostic.file).sort()).toEqual(
        Object.keys(files).sort(),
    );
    expect(diagnostics.every((diagnostic) => diagnostic.rule === "function-length")).toBe(true);
    expect(diagnostics.every((diagnostic) => diagnostic.message.includes("71 lines"))).toBe(true);
});

test("constructors, accessors and callbacks follow the same function limit", async () => {
    const body = "void 0;\n".repeat(70);
    const temporary = await project({
        "example.ts": `
class Example {
    constructor() {\n${body}}
    get value() {\n${body}return 1; }
    set value(value: number) {\n${body}void value; }
}
const callback = () => {\n${body}};
const expression = function () {\n${body}};
const literal = { enabled: true } as const;
const checked = { enabled: true } satisfies { enabled: boolean };
const cast = checked as { enabled: string };
const angle = <string>literal;
`,
    });
    const diagnostics = await checkTypeScriptStyle(temporary);
    expect(diagnostics.filter((diagnostic) => diagnostic.rule === "function-length")).toHaveLength(
        5,
    );
    expect(diagnostics.filter((diagnostic) => diagnostic.rule === "type-assertion")).toHaveLength(
        2,
    );
    expect(diagnostics.filter((entry) => entry.rule !== "logical-spacing")).toHaveLength(7);
});

test("Bun suite registration does not exempt the test bodies it contains", async () => {
    const body = "    void 0;\n".repeat(70);
    const temporary = await project({
        "example.test.ts": `import { describe, test } from "bun:test";
describe("suite", () => {
    test("long body", () => {\n${body}    });
});
`,
    });
    const diagnostics = (await checkTypeScriptStyle(temporary)).filter(
        (entry) => entry.rule === "function-length",
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.line).toBe(3);
});

test("the line limit checks code around embedded source without changing literal data", async () => {
    const literal = "x".repeat(150);
    const expression = Array.from({ length: 20 }, (_, index) => `value_${index}`).join(" + ");
    const temporary = await project({
        "data.ts": `export const originalSource = "${literal}";\n`,
        "code.ts": `export const result = ${expression};\n`,
    });
    const diagnostics = await checkTypeScriptStyle(temporary);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.file).toBe("code.ts");
    expect(diagnostics[0]?.rule).toBe("line-width");
    expect(await Bun.file(join(temporary, "data.ts")).text()).toContain(literal);
});

test("missing project inputs and invalid syntax fail the style check", async () => {
    const empty = await project({});
    await expect(checkTypeScriptStyle(empty)).rejects.toThrow("no project files");
    const invalid = await project({ "example.ts": "export function broken( {" });
    await expect(checkTypeScriptStyle(invalid)).rejects.toThrow("syntax errors");
});

test("managed checks reject long functions, long lines, ternaries and missing braces", async () => {
    const temporary = await project({});
    const path = join(temporary, "Example.cs");
    await Bun.write(
        path,
        `
class Example
{
  // Wrong indentation must fail even in templates and project resources.
    int Choose(bool condition) => condition ? 1 : 0;
    void Branch(bool condition) { if (condition) return; }
    void Loop() { for (int index = 0; index < 1; index++) continue; }
    void Long()
    {
${"        System.Console.WriteLine();\n".repeat(70)}    }
    // ${"x".repeat(101)}
}
`,
    );
    const command = Bun.spawn([process.execPath, "run", "scripts/style/managed.ts", path], {
        cwd: directory,
        stdout: "pipe",
        stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
        command.exited,
        new Response(command.stdout).text(),
        new Response(command.stderr).text(),
    ]);
    expect(exitCode).toBe(1);
    const output = stdout + stderr;
    expect(output).toContain("function-length");
    expect(output).toContain("line-width");
    expect(output).toContain("indentation");
    expect(output).toContain("explicit-branches");
    expect(output.match(/explicit-blocks/g)).toHaveLength(2);
}, 20_000);

test("Ultracite rejects compressed branches, nested ternaries and unchecked types under Bun", async () => {
    const temporary = await project({
        "example.ts": `
let input: any;
if (input) input = input.a ? input.b ? 1 : 2 : 3;
`,
    });
    const bin = join(temporary, "bin");
    await mkdir(bin);
    await symlink(process.execPath, join(bin, "bun"));
    const command = Bun.spawn(
        [
            process.execPath,
            "--bun",
            "run",
            "oxlint",
            "--config",
            join(directory, "oxlint.config.ts"),
            join(temporary, "example.ts"),
        ],
        {
            cwd: directory,
            stdout: "pipe",
            stderr: "pipe",
            env: { ...Bun.env, PATH: bin },
        },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
        command.exited,
        new Response(command.stdout).text(),
        new Response(command.stderr).text(),
    ]);
    expect(exitCode).toBe(1);
    const output = stdout + stderr;
    expect(output).toContain("curly");
    expect(output).toContain("no-nested-ternary");
    expect(output).toContain("no-explicit-any");
});

test("control-flow phases and methods require blank lines", async () => {
    const temporary = await project({
        "example.ts": `
export function select(enabled: boolean) {
    const value = 1;
    if (enabled) {
        return value;
    }
    return 0;
}
`,
    });
    const diagnostics = await checkTypeScriptStyle(temporary);
    expect(diagnostics.filter((entry) => entry.rule === "logical-spacing")).toHaveLength(2);
});

test("cross-file aliases cannot hide mutually recursive calls", async () => {
    const temporary = await project({
        "first.ts": `import { second as next } from "./second";
export function first() {
    return next();
}
`,
        "second.ts": `import { first as next } from "./first";
export function second() {
    return next();
}
`,
    });
    const diagnostics = await checkTypeScriptStyle(temporary);
    expect(diagnostics.filter((entry) => entry.rule === "recursion")).toHaveLength(2);
});

test("getters, setters and constructors cannot hide recursive execution", async () => {
    const temporary = await project({
        "example.ts": `
class Get {
    get value(): number { return this.value; }
}
class Set {
    set value(value: number) { this.value = value; }
}
class Construct {
    constructor() { new Construct(); }
}
`,
    });
    const diagnostics = await checkTypeScriptStyle(temporary);
    expect(diagnostics.filter((entry) => entry.rule === "recursion")).toHaveLength(3);
});

test("Ultracite retains type-aware Promise checks and the cognitive complexity limit", async () => {
    const nested = `${"if (enabled) {\n".repeat(10)}return 1;\n${"}\n".repeat(10)}`;
    const temporary = await project({
        "example.ts": `
export function complex(enabled: boolean) {
${nested}
    return 0;
}
async function work(): Promise<number> { return 1; }
work();
`,
    });
    const command = Bun.spawn(
        [
            process.execPath,
            "--bun",
            "run",
            "oxlint",
            "--config",
            join(directory, "oxlint.config.ts"),
            join(temporary, "example.ts"),
        ],
        { cwd: directory, stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
        command.exited,
        new Response(command.stdout).text(),
        new Response(command.stderr).text(),
    ]);
    expect(exitCode).toBe(1);
    expect(stdout + stderr).toContain("no-floating-promises");
    expect(stdout + stderr).toContain("Cognitive Complexity");
});

test("owned files excluded from the TypeScript project cannot escape style coverage", async () => {
    const temporary = await project({
        "entry.ts": "export const value = 1;",
        "src/hidden.ts": "export const hidden = 2;",
    });
    await Bun.write(join(temporary, "tsconfig.json"), JSON.stringify({ include: ["entry.ts"] }));
    await expect(checkTypeScriptStyle(temporary)).rejects.toThrow("src/hidden.ts");
});
