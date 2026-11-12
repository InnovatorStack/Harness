import { setupBytesMax, setupFilesMax } from "../core/limits.js";
import type { Fixtures } from "../fixtures/types.js";
import { PackageFileError, readText } from "../packages/files.js";
import { parseAml } from "../packages/parser.js";
import type { AmlDocument } from "../packages/types.js";
import type { ResolvedConfig } from "./configuration.js";

export interface SetupSource {
    readonly path: string;
    readonly xml: string;
}

const readsParallelMax = 32;

/** Hash actual bytes on each creation; unchanged inputs do not need parsing or import. */
export async function readSetupSources(paths: readonly string[]): Promise<readonly SetupSource[]> {
    if (paths.length > setupFilesMax) {
        throw new PackageFileError("PackageReadFailed", "<setup>", "Too many setup inputs.");
    }

    const sources: SetupSource[] = [];
    let bytes = 0;

    for (let offset = 0; offset < paths.length; offset += readsParallelMax) {
        const batch = await Promise.all(
            paths.slice(offset, offset + readsParallelMax).map(async (path) => ({
                path,
                xml: await readText(path),
            })),
        );

        for (const source of batch) {
            bytes += source.xml.length * 3;

            if (bytes > setupBytesMax) {
                throw new PackageFileError(
                    "PackageReadFailed",
                    source.path,
                    "Setup inputs exceed the byte limit.",
                );
            }

            sources.push(source);
        }
    }

    return sources;
}

export function setupKey(
    configuration: ResolvedConfig,
    sources: readonly SetupSource[],
    packages: number,
    fixtures: Fixtures,
    runtime: string,
): string {
    const settings = configuration.settings;
    const hash = new Bun.CryptoHasher("sha256").update(
        JSON.stringify({
            directory: configuration.directory,
            runtime,
            packages,
            fixtures,
            clock: settings.clock,
            ids: settings.ids,
            session: settings.session,
            authorization: settings.authorization,
        }),
    );

    for (const source of sources) {
        hash.update(JSON.stringify([source.path, source.xml.length])).update(source.xml);
    }

    return hash.digest("hex");
}

export function parseSetupSources(sources: readonly SetupSource[]): readonly AmlDocument[] {
    return sources.map((source) => parseAml(source.xml, source.path));
}
