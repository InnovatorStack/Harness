import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Deadline } from "../../core/deadline.js";
import { errorMessage } from "../../core/errors.js";
import { readBinaryFile, readTextFile } from "../../core/files.js";
import { readProcessOutput } from "../../core/process.js";
import { PlatformError } from "../../platform/errors.js";
import type { MethodDefinition } from "../types.js";
import { cachedAssembly } from "./cache.js";
import { methodBuildIdentity, methodCompilerArguments } from "./method-build.js";
import { eventArgumentType, methodTemplate, renderMethod } from "./templates.js";

export interface CSharpOptions {
    readonly dotnet?: string;
    readonly cacheDirectory?: string;
    readonly references?: readonly string[];
    readonly timeoutMs?: number;
}

export interface CompiledMethod {
    readonly assembly: string;
    readonly typeName: string;
}

const buildsMax = 128;
const buildTimeoutMs = 60_000;
const builds = new Map<string, Promise<string>>();
const interopDirectory = Bun.fileURLToPath(new URL("managed/", import.meta.url));

const hostBuildArguments = [
    "build",
    "Project.csproj",
    "--nologo",
    "--verbosity",
    "quiet",
    "--output",
    "bin",
];

async function compileOnce(key: string, build: () => Promise<string>): Promise<string> {
    const existing = builds.get(key);

    if (existing) {
        return await existing;
    }

    if (builds.size >= buildsMax) {
        throw new PlatformError("CSharpUnavailable", "The managed build queue is full.");
    }

    const pending = build();
    builds.set(key, pending);

    try {
        return await pending;
    } finally {
        builds.delete(key);
    }
}

export class CSharpCompiler {
    readonly references: readonly string[];
    readonly dotnet: string;
    readonly timeoutMs: number;
    private readonly cache: string;
    private hostBuild: Promise<string> | undefined;

    constructor(options: CSharpOptions) {
        this.dotnet = options.dotnet ?? "dotnet";
        this.references = (options.references ?? []).map((path) => resolve(path));
        this.timeoutMs = options.timeoutMs ?? 30_000;

        if (
            !Number.isSafeInteger(this.timeoutMs) ||
            this.timeoutMs < 1 ||
            this.timeoutMs > 2_147_483_647
        ) {
            throw new TypeError(
                "The C# timeout must be a positive integer within the timer range.",
            );
        }

        if (this.references.length > 128) {
            throw new TypeError("Too many C# reference assemblies were supplied.");
        }

        this.cache =
            options.cacheDirectory ??
            join(Bun.env.XDG_CACHE_HOME ?? tmpdir(), "innovator-harness", "csharp");
    }

    host(): Promise<string> {
        this.hostBuild ??= this.compileHost();

        return this.hostBuild;
    }

    private async compileHost(): Promise<string> {
        const sourceDirectory = interopDirectory;
        const files = [
            "Protocol.cs",
            "ProtocolInput.cs",
            "ProtocolJson.cs",
            "DomChanges.cs",
            "Item.cs",
            "ItemXml.cs",
            "LogicalData.cs",
            "LogicalXml.cs",
            "PayloadXml.cs",
            "XmlTraversal.cs",
            "WorkLimits.cs",
            "Innovator.cs",
            "CallContext.cs",
            "ErrorLookup.cs",
            "Identity.cs",
            "Permissions.cs",
            "RemoteContext.cs",
            "MethodContext.cs",
            "MethodAssemblies.cs",
            "MethodInvocation.cs",
            "ContextSafety.cs",
            "Connections.cs",
            "ServerEventArgs.cs",
            "InOutInvocation.cs",
            "ResponseXml.cs",
            "XmlProperties.cs",
            "Program.cs",
        ];
        const sources = await Promise.all(
            files.map(async (file) => ({
                file,
                bytes: await readBinaryFile(join(sourceDirectory, file)),
            })),
        );
        const project = await readTextFile(join(sourceDirectory, "Worker.csproj"));
        const nuget = await readTextFile(join(sourceDirectory, "NuGet.Config"));
        const hash = new Bun.CryptoHasher("sha256").update("managed-worker-v3:net10.0");

        for (const source of sources) {
            hash.update(JSON.stringify([source.file, source.bytes.length])).update(source.bytes);
        }

        hash.update(JSON.stringify([project, nuget]));
        const identity = hash.digest("hex");
        const output = join(this.cache, "host", identity);

        return await compileOnce(`${this.dotnet}:${output}`, () =>
            cachedAssembly(output, "InnovatorHarness.Managed.dll", async (staging) => {
                for (const source of sources) {
                    await Bun.write(join(staging, source.file), source.bytes);
                }

                await this.writeProject(staging, project);
                await this.build(staging, hostBuildArguments);
            }),
        );
    }

    async method(
        method: MethodDefinition,
        host: string,
        eventName?: string,
    ): Promise<CompiledMethod> {
        const selected = methodTemplate(method.code);
        const methodSource = await readTextFile(join(interopDirectory, selected));
        const eventType = selected === "InOut.cs.template" ? eventArgumentType(eventName) : "";
        const identity = await methodBuildIdentity(
            { method, host, source: methodSource, event: eventType },
            this.references,
        );
        const typeName = `InnovatorHarness.Generated.Method_${identity}`;
        const output = join(this.cache, "methods", identity);
        const assembly = await compileOnce(
            `${this.dotnet}:${output}`,
            async () =>
                await cachedAssembly(output, `Method_${identity}.dll`, async (staging) => {
                    const source = renderMethod(
                        methodSource,
                        method,
                        `Method_${identity}`,
                        eventType,
                    );
                    await Bun.write(join(staging, "Method.cs"), source);

                    try {
                        await this.build(
                            staging,
                            await methodCompilerArguments(
                                host,
                                staging,
                                `Method_${identity}`,
                                this.references,
                            ),
                        );
                    } catch (error) {
                        throw new PlatformError(
                            "MethodCompilationFailed",
                            `Cannot compile '${method.name}' from ` +
                                `${method.source.file}:${method.source.line}. ${errorMessage(error)}`,
                            { cause: error },
                        );
                    }
                }),
        );

        return { assembly, typeName };
    }

    private async writeProject(directory: string, project: string): Promise<void> {
        await Bun.write(join(directory, "Project.csproj"), project);
        await Bun.write(
            join(directory, "NuGet.Config"),
            await readTextFile(join(interopDirectory, "NuGet.Config")),
        );
    }

    private startCompiler(
        directory: string,
        arguments_: readonly string[],
    ): Bun.Subprocess<"ignore", "pipe", "pipe"> {
        try {
            return Bun.spawn([this.dotnet, ...arguments_], {
                cwd: directory,
                stdin: "ignore",
                stdout: "pipe",
                stderr: "pipe",
                timeout: 60_000,
                env: {
                    ...Bun.env,
                    DOTNET_NOLOGO: "1",
                    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
                    DOTNET_CLI_TELEMETRY_OPTOUT: "1",
                },
            });
        } catch (error) {
            throw new PlatformError(
                "CSharpUnavailable",
                "The C# executor requires an installed .NET 10 SDK. No SDK is downloaded automatically.",
                { cause: error },
            );
        }
    }

    private async build(directory: string, arguments_: readonly string[]): Promise<void> {
        const process = this.startCompiler(directory, arguments_);

        using deadline = new Deadline(
            buildTimeoutMs,
            () =>
                new PlatformError("CSharpBuildFailed", "The managed build exceeded its deadline."),
        );
        let result: [number, string, string];

        try {
            result = await deadline.wait(
                Promise.all([
                    process.exited,
                    readProcessOutput(process.stdout, deadline.signal),
                    readProcessOutput(process.stderr, deadline.signal),
                ]),
            );
        } finally {
            process.kill("SIGKILL");
        }

        const [exitCode, stdout, stderr] = result;

        if (exitCode !== 0) {
            throw new PlatformError(
                "CSharpBuildFailed",
                `Managed build failed (${exitCode}):\n${stdout}\n${stderr}`,
            );
        }
    }
}
