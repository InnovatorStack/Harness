import { posix } from "node:path";

interface SourceMap {
    readonly version: number;
    readonly file: string;
    readonly sourceRoot: string;
    readonly sources: readonly string[];
    readonly mappings: string;
}

export interface SourceMapEvidence {
    readonly maps: number;
    readonly sources: number;
}

const sourcesPerMapMax = 20_000;

/** Declaration navigation and debugger links must resolve inside the published package. */
export async function auditSourceMaps(
    files: ReadonlyMap<string, Blob>,
): Promise<SourceMapEvidence> {
    const sources = new Set<string>();
    let maps = 0;

    for (const [path, file] of files) {
        if (!path.startsWith("package/dist/")) {
            continue;
        }

        if (path.endsWith(".map")) {
            const map = readSourceMap(path, await file.text());

            for (const source of map.sources) {
                sources.add(resolveSource(path, map.sourceRoot, source, files));
            }

            maps += 1;
        } else if (path.endsWith(".js") || path.endsWith(".d.ts")) {
            assertOutputMapping(path, await file.text(), files);
        }
    }

    return { maps, sources: sources.size };
}

function readSourceMap(path: string, text: string): SourceMap {
    const value: unknown = JSON.parse(text);

    if (!isSourceMap(value) || value.file !== posix.basename(path, ".map")) {
        throw new Error(`Invalid generated source map '${path}'.`);
    }

    return value;
}

function isSourceMap(value: unknown): value is SourceMap {
    return (
        typeof value === "object" &&
        value !== null &&
        "version" in value &&
        value.version === 3 &&
        "file" in value &&
        typeof value.file === "string" &&
        "sourceRoot" in value &&
        typeof value.sourceRoot === "string" &&
        "mappings" in value &&
        typeof value.mappings === "string" &&
        "sources" in value &&
        Array.isArray(value.sources) &&
        value.sources.length > 0 &&
        value.sources.length <= sourcesPerMapMax &&
        value.sources.every((source: unknown) => typeof source === "string")
    );
}

function resolveSource(
    map: string,
    root: string,
    source: string,
    files: ReadonlyMap<string, Blob>,
): string {
    for (const component of [root, source]) {
        if (
            component.startsWith("/") ||
            component.includes("\\") ||
            component.includes(":") ||
            component.includes("\0")
        ) {
            throw new Error(`Source map '${map}' must use relative package paths.`);
        }
    }

    const target = posix.normalize(posix.join(posix.dirname(map), root, source));

    if (!target.startsWith("package/src/") || !target.endsWith(".ts") || !files.has(target)) {
        throw new Error(`Missing packaged framework source for '${map}'.`);
    }

    return target;
}

function assertOutputMapping(path: string, text: string, files: ReadonlyMap<string, Blob>): void {
    const reference = /\/\/# sourceMappingURL=([^\r\n]+)\s*$/u.exec(text)?.[1]?.trim();
    const expected = `${posix.basename(path)}.map`;

    if (reference !== expected || !files.has(`${path}.map`)) {
        throw new Error(`Missing generated source map for '${path}'.`);
    }
}
