import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";

import { Deadline } from "../core/deadline.js";
import { readTextFile } from "../core/files.js";
import { setupBytesMax, setupFilesMax } from "../core/limits.js";
import { withTemporaryDirectory } from "../core/resources.js";
import { resolveSetupImports } from "./setup-imports.js";

const setupTimeoutMs = 60_000;

/** Load a fresh local setup graph, including imported data and helper modules. */
export async function loadSetupModule(path: string): Promise<unknown> {
    using deadline = new Deadline(
        setupTimeoutMs,
        () => new Error(`Harness setup '${path}' exceeded its loading deadline.`),
    );
    const result = await deadline.wait(
        Bun.build({
            entrypoints: [path],
            target: "bun",
            format: "esm",
            packages: "external",
            sourcemap: "inline",
            plugins: [locationPlugin()],
        }),
    );

    if (!result.success) {
        throw new AggregateError(result.logs, `Cannot load Harness setup module '${path}'.`);
    }

    const output = result.outputs[0];

    if (!output) {
        throw new Error(`No compiled setup module was produced for '${path}'.`);
    }

    return await withTemporaryDirectory(
        join(tmpdir(), "innovator-harness-setup-"),
        async (directory) => {
            const temporary = join(directory, "setup.mjs");
            await Bun.write(temporary, output);

            const module: unknown = await deadline.wait(import(temporary));

            return module;
        },
    );
}

function locationPlugin(): Bun.BunPlugin {
    let files = 0;
    let bytes = 0;

    return {
        name: "harness-setup-locations",

        setup(build) {
            build.onResolve({ filter: /^(?:file:|bun:|node:)/ }, (input) => ({
                path: input.path,
                external: true,
            }));
            build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async (input) => {
                files += 1;

                if (files > setupFilesMax) {
                    throw new Error("The Harness setup module graph has too many files.");
                }

                const source = await readTextFile(input.path);
                bytes += source.length * 3;

                if (bytes > setupBytesMax) {
                    throw new Error("The Harness setup module graph exceeds its byte limit.");
                }

                const compiled = transpilerFor(input.path).transformSync(source);
                const contents = await resolveSetupImports(compiled, input.path);

                return { contents, loader: "js" };
            });
        },
    };
}

function transpilerFor(path: string): Bun.Transpiler {
    return new Bun.Transpiler({
        loader: sourceLoader(path),
        target: "bun",
        define: {
            "import.meta.dir": JSON.stringify(dirname(path)),
            "import.meta.dirname": JSON.stringify(dirname(path)),
            "import.meta.path": JSON.stringify(path),
            "import.meta.filename": JSON.stringify(path),
            "import.meta.url": JSON.stringify(Bun.pathToFileURL(path).href),
            "import.meta.main": "false",
        },
    });
}

function sourceLoader(path: string): "js" | "jsx" | "ts" | "tsx" {
    const extension = extname(path);

    if (extension === ".tsx") {
        return "tsx";
    }

    if (extension === ".jsx") {
        return "jsx";
    }

    if (extension === ".ts" || extension === ".mts" || extension === ".cts") {
        return "ts";
    }

    return "js";
}
