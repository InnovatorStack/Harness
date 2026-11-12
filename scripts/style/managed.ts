import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { readProcessOutput } from "../../src/core/process.js";

export async function checkManagedStyle(
    directory: string,
    inputs?: readonly string[],
    layoutOnly = false,
): Promise<number> {
    const compiler = await managedCompiler();
    const temporary = await mkdtemp(join(tmpdir(), "harness-style-"));

    try {
        const project = managedProject(directory, compiler);
        await Bun.write(join(temporary, "Style.csproj"), project);
        const build = Bun.spawn(["dotnet", "build", "--nologo", "--verbosity", "quiet"], {
            cwd: temporary,
            timeout: 60_000,
            stdout: "pipe",
            stderr: "pipe",
        });
        const [exitCode, stdout, stderr] = await Promise.all([
            build.exited,
            readProcessOutput(build.stdout),
            readProcessOutput(build.stderr),
        ]);

        if (exitCode !== 0) {
            throw new Error(`Cannot build the managed style checker:\n${stdout}\n${stderr}`);
        }

        const files = inputs ?? (await managedFiles(directory));
        const mode = layoutOnly ? ["--format-layout"] : [];
        const check = Bun.spawn(
            ["dotnet", join(temporary, "bin", "Debug", "net10.0", "Style.dll"), ...mode, ...files],
            { cwd: directory, stdout: "inherit", stderr: "inherit", timeout: 60_000 },
        );

        return await check.exited;
    } finally {
        await rm(temporary, { recursive: true, force: true });
    }
}

async function managedCompiler(): Promise<string> {
    const process = Bun.spawn(["dotnet", "--list-sdks"], {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 60_000,
    });
    const [exitCode, stdout, stderr] = await Promise.all([
        process.exited,
        readProcessOutput(process.stdout),
        readProcessOutput(process.stderr),
    ]);

    if (exitCode !== 0) {
        throw new Error(`Cannot inspect the existing .NET SDK: ${stderr}`);
    }

    const installations = [...stdout.matchAll(/^(10\.\d+\.\d+)\s+\[([^\]]+)\]/gm)];
    const selected = installations.at(-1);

    if (!selected?.[1] || !selected[2]) {
        throw new Error("Checking managed source requires the existing .NET 10 SDK.");
    }

    return join(selected[2], selected[1], "Roslyn", "bincore");
}

function managedProject(directory: string, compiler: string): string {
    const source = escapeXml(join(directory, "scripts/style/*.cs"));
    const common = escapeXml(join(compiler, "Microsoft.CodeAnalysis.dll"));
    const csharp = escapeXml(join(compiler, "Microsoft.CodeAnalysis.CSharp.dll"));

    return `<Project Sdk="Microsoft.NET.Sdk">
    <PropertyGroup>
        <OutputType>Exe</OutputType>
        <TargetFramework>net10.0</TargetFramework>
        <ImplicitUsings>enable</ImplicitUsings>
        <Nullable>enable</Nullable>
        <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
        <EnableDefaultCompileItems>false</EnableDefaultCompileItems>
    </PropertyGroup>
    <ItemGroup>
        <Compile Include="${source}" />
        <Reference Include="Microsoft.CodeAnalysis"><HintPath>${common}</HintPath></Reference>
        <Reference Include="Microsoft.CodeAnalysis.CSharp"><HintPath>${csharp}</HintPath></Reference>
    </ItemGroup>
</Project>`;
}

function escapeXml(value: string): string {
    return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

async function managedFiles(directory: string): Promise<readonly string[]> {
    const files: string[] = [];
    const patterns = [
        "src/**/*.cs",
        "scripts/**/*.cs",
        "src/**/*.cs.template",
        "src/**/*.csproj",
        "src/**/*.csproj.template",
        "src/**/NuGet.Config",
    ];

    for (const pattern of patterns) {
        for await (const path of new Bun.Glob(pattern).scan({ cwd: directory })) {
            if (!path.includes("/obj/") && !path.includes("/bin/")) {
                files.push(resolve(directory, path));
            }
        }
    }

    if (files.length === 0) {
        throw new Error("The style checker found no owned managed source files.");
    }

    return files.sort();
}

export async function formatManagedSource(directory: string, write: boolean): Promise<number> {
    const files = await managedFiles(directory);
    const temporary = await mkdtemp(join(tmpdir(), "harness-format-"));

    try {
        await Bun.write(
            join(temporary, ".editorconfig"),
            Bun.file(join(directory, ".editorconfig")),
        );
        const copies: { original: string; copy: string }[] = [];

        for (const [index, original] of files.entries()) {
            if (!original.endsWith(".cs")) {
                continue;
            }

            const copy = join(temporary, "source", `${index}.cs`);
            await mkdir(dirname(copy), { recursive: true });
            await Bun.write(copy, Bun.file(original));
            copies.push({ original, copy });
        }

        // Only these copies enter the formatter. Private packages and generated Methods never do.
        const formatter = Bun.spawn(
            ["dotnet", "format", "whitespace", temporary, "--folder", "--verbosity", "quiet"],
            { stdout: "inherit", stderr: "inherit", timeout: 60_000 },
        );
        const exitCode = await formatter.exited;

        if (exitCode !== 0) {
            return exitCode;
        }

        const layoutExit = await checkManagedStyle(
            directory,
            copies.map((copy) => copy.copy),
            true,
        );

        if (layoutExit !== 0) {
            return layoutExit;
        }

        let changed = false;

        for (const { original, copy } of copies) {
            const formatted = await Bun.file(copy).text();

            if (formatted === (await Bun.file(original).text())) {
                continue;
            }

            changed = true;

            if (write) {
                await Bun.write(original, formatted);
            } else {
                console.error(`${original}: managed formatting differs; run bun run format.`);
            }
        }

        if (changed && !write) {
            return 1;
        }

        return 0;
    } finally {
        await rm(temporary, { recursive: true, force: true });
    }
}

if (import.meta.main) {
    const files = process.argv.slice(2);
    process.exitCode = await checkManagedStyle(
        resolve(dirname(import.meta.path), "../.."),
        files.length > 0 ? files : undefined,
    );
}
