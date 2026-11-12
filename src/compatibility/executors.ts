import { stat } from "node:fs/promises";

import { errorMessage } from "../core/errors.js";
import { readProcessOutput } from "../core/process.js";
import type { PackageConfiguration } from "../harness/configuration.js";
import { resolveCSharpOptions } from "../harness/configuration.js";
import { CSharpCompiler } from "../methods/csharp/compiler.js";
import type { MethodDefinition } from "../methods/types.js";
import { PlatformError } from "../platform/errors.js";
import type { CatalogEntry } from "../storage/types.js";
import { CompilationStatus, ExecutorStatus } from "./types.js";
import type { CompilationCheck, ExecutorCheck } from "./types.js";

/** Checks dependencies lazily; neither the managed worker nor consumer extension factories
 * start. */
export class ExecutorInspection {
    private environment: Promise<ExecutorCheck> | undefined;
    private host: Promise<string> | undefined;
    private readonly compiler: CSharpCompiler;
    private readonly compiled = new Map<string, Promise<CompilationCheck>>();

    constructor(
        private readonly configuration: PackageConfiguration,
        private readonly bindings: readonly CatalogEntry[] = [],
    ) {
        this.compiler = new CSharpCompiler(resolveCSharpOptions(configuration));
    }

    async executor(language: string | undefined, needed: boolean): Promise<ExecutorCheck> {
        const extensions = (this.configuration.settings.executors?.length ?? 0) > 0;

        if (language?.toLowerCase() !== "c#") {
            return Object.freeze({
                status: extensions ? ExecutorStatus.Unknown : ExecutorStatus.Missing,
                message: extensions
                    ? "Custom executor factories require runtime inspection; they are not constructed by preflight."
                    : `No built-in '${language ?? "unspecified"}' executor.`,
            });
        }

        if (this.configuration.settings.csharp === false) {
            return Object.freeze({
                status: extensions ? ExecutorStatus.Unknown : ExecutorStatus.Disabled,
                message: "The built-in C# executor is disabled.",
            });
        }

        if (!needed) {
            return Object.freeze({
                status: ExecutorStatus.Unknown,
                message:
                    "C# is configured; dependency probes are skipped for unconditionally mocked source.",
            });
        }

        this.environment ??= this.probe();

        return await this.environment;
    }

    compile(method: MethodDefinition): Promise<CompilationCheck> {
        const key = `${method.id}:${method.hash}`;
        let result = this.compiled.get(key);

        if (!result) {
            result = this.compileMethod(method);
            this.compiled.set(key, result);
        }

        return result;
    }

    private async probe(): Promise<ExecutorCheck> {
        const missing: string[] = [];

        for (const reference of this.compiler.references) {
            try {
                if (!(await stat(reference)).isFile()) {
                    missing.push(reference);
                    continue;
                }

                await Bun.file(reference).slice(0, 1).bytes();
            } catch {
                missing.push(reference);
            }
        }

        if (missing.length > 0) {
            return Object.freeze({
                status: ExecutorStatus.Unavailable,
                message: `Missing or unreadable configured C# assemblies: ${missing.join(", ")}.`,
            });
        }

        try {
            const process = Bun.spawn([this.compiler.dotnet, "--list-sdks"], {
                stdin: "ignore",
                stdout: "pipe",
                stderr: "pipe",
                timeout: 5000,
            });
            const [exitCode, stdout, stderr] = await Promise.all([
                process.exited,
                readProcessOutput(process.stdout),
                readProcessOutput(process.stderr),
            ]);

            if (exitCode !== 0 || !/^10\.\d+\.\d+/m.test(stdout)) {
                return Object.freeze({
                    status: ExecutorStatus.Unavailable,
                    message: `The C# executor requires the .NET 10 SDK. ${stderr.trim()}`.trim(),
                });
            }

            return Object.freeze({ status: ExecutorStatus.Available });
        } catch (error) {
            return Object.freeze({
                status: ExecutorStatus.Unavailable,
                message: `Cannot inspect the .NET 10 SDK: ${errorMessage(error)}`,
            });
        }
    }

    private async compileMethod(method: MethodDefinition): Promise<CompilationCheck> {
        try {
            this.host ??= this.compiler.host();
            const events = this.eventContexts(method);

            for (const event of events) {
                await this.compiler.method(method, await this.host, event);
            }

            return Object.freeze({ status: CompilationStatus.Compiled, sourceHash: method.hash });
        } catch (error) {
            const inputChanged =
                error instanceof Error &&
                "code" in error &&
                ["ENOENT", "EACCES", "EISDIR", "ENOTDIR"].includes(String(error.code));

            if (!(error instanceof PlatformError) && !inputChanged) {
                throw error;
            }

            return Object.freeze({
                status: CompilationStatus.Failed,
                sourceHash: method.hash,
                message: errorMessage(error),
            });
        }
    }

    private eventContexts(method: MethodDefinition): readonly (string | undefined)[] {
        const supported = new Set([
            "onget",
            "onadd",
            "onupdate",
            "ondelete",
            "onlock",
            "onunlock",
            "onpromote",
            "onbeforeupdate",
            "onafteradd",
            "onafterupdate",
            "onafterversion",
        ]);
        const contexts = new Set<string | undefined>();

        for (const binding of this.bindings) {
            if (String(binding.properties.related_id).toLowerCase() !== method.id.toLowerCase()) {
                continue;
            }

            const name = String(binding.properties.server_event);
            contexts.add(supported.has(name.toLowerCase()) ? name : undefined);
        }

        return contexts.size > 0 ? [...contexts] : [undefined];
    }
}
