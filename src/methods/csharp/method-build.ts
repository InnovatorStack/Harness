import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { readBinaryFile, readTextFile } from "../../core/files.js";
import { PlatformError } from "../../platform/errors.js";
import type { MethodDefinition } from "../types.js";

const interopDirectory = Bun.fileURLToPath(new URL("managed/", import.meta.url));
const hostIdentities = new Map<string, Promise<string>>();

export async function methodBuildIdentity(
    inputs: {
        readonly method: MethodDefinition;
        readonly host: string;
        readonly source: string;
        readonly event: string;
    },
    references: readonly string[],
): Promise<string> {
    const method = inputs.method;
    const hash = new Bun.CryptoHasher("sha256")
        .update("direct-shared-sdk-csc-v4")
        .update(inputs.source)
        .update(inputs.event)
        .update(method.id)
        .update(method.name)
        .update(method.code)
        .update(method.source.file)
        .update(String(method.source.line))
        .update(await hostIdentity(inputs.host))
        .update(await readTextFile(join(interopDirectory, "GlobalUsings.cs.template")));

    for (const reference of references) {
        hash.update(reference).update(await readBinaryFile(reference));
    }

    return hash.digest("hex");
}

async function hostIdentity(host: string): Promise<string> {
    const cached = hostIdentities.get(host);

    if (cached) {
        return await cached;
    }

    if (hostIdentities.size >= 16) {
        hostIdentities.clear();
    }

    const pending = (async () => {
        const contents = await Promise.all(
            [
                hostContract(host),
                join(dirname(host), "Newtonsoft.Json.dll"),
                join(dirname(host), "compiler-symbols.txt"),
            ].map((path) => readBinaryFile(path)),
        );
        const hash = new Bun.CryptoHasher("sha256");

        for (const bytes of contents) {
            hash.update(String(bytes.length)).update(bytes);
        }

        return hash.digest("hex");
    })();
    hostIdentities.set(host, pending);

    try {
        return await pending;
    } catch (error) {
        hostIdentities.delete(host);

        throw error;
    }
}

export function hostContract(host: string): string {
    return join(dirname(host), "ref", "InnovatorHarness.Managed.dll");
}

/** Use the installed SDK compiler directly; business Methods need no restore or MSBuild run. */
export async function methodCompilerArguments(
    host: string,
    directory: string,
    name: string,
    references: readonly string[],
): Promise<readonly string[]> {
    const inputs = (await readTextFile(join(dirname(host), "compiler-inputs.txt")))
        .split(/\r?\n/u)
        .filter(Boolean);
    const compiler = inputs[0];
    const symbols = (await readTextFile(join(dirname(host), "compiler-symbols.txt")))
        .split(/\r?\n/u)
        .filter(Boolean);

    if (!compiler || inputs.length < 2 || inputs.length > 1024) {
        throw new PlatformError(
            "CSharpUnavailable",
            "The managed host has invalid SDK compiler inputs.",
        );
    }

    await mkdir(join(directory, "bin"), { recursive: true });
    await Bun.write(
        join(directory, "GlobalUsings.cs"),
        await readTextFile(join(interopDirectory, "GlobalUsings.cs.template")),
    );
    const arguments_ = [
        "/nologo",
        "/target:library",
        "/nostdlib+",
        "/deterministic+",
        "/nullable:enable",
        "/optimize+",
        "/debug:portable",
        "/langversion:latest",
        `/define:${symbols.join(";")}`,
        `/out:${join(directory, "bin", `${name}.dll`)}`,
        ...[...inputs.slice(1), hostContract(host), ...references].map(
            (path) => `/reference:${path}`,
        ),
        join(directory, "GlobalUsings.cs"),
        join(directory, "Method.cs"),
    ];
    const response = join(directory, "compiler.rsp");
    await Bun.write(response, arguments_.map(quoteArgument).join("\n"));

    return [compiler, "/shared", `@${response}`];
}

function quoteArgument(value: string): string {
    if (/[\r\n]/u.test(value)) {
        throw new PlatformError(
            "CSharpUnavailable",
            "Compiler input paths cannot contain newlines.",
        );
    }

    return `"${value.replaceAll(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, "$1$1")}"`;
}
