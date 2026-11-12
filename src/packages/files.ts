import { lstat, readdir, realpath } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

import { readTextFile, TextEncodingError } from "../core/files.js";
import { setupBytesMax, setupFilesMax } from "../core/limits.js";
import { PackageImportError } from "./diagnostics.js";
import { manifestPaths } from "./manifest.js";
import { AmlParseError, parseAml } from "./parser.js";
import type { AmlDocument, PackageSource } from "./types.js";

export class PackageFileError extends Error {
    override readonly name = "PackageFileError";

    constructor(
        readonly code: string,
        readonly path: string,
        message: string,
        options?: ErrorOptions,
    ) {
        super(`${path}: ${message}`, options);
    }
}

export async function loadAmlDocuments(
    sources: readonly PackageSource[],
): Promise<readonly AmlDocument[]> {
    const files = await resolvePackageFiles(sources);
    const documents: AmlDocument[] = [];
    let bytes = 0;

    for (const path of files) {
        const document = await readAmlDocument(path);
        bytes += document.xml.length * 3;

        if (bytes > setupBytesMax) {
            throw new PackageFileError(
                "PackageReadFailed",
                path,
                "Package inputs exceed the setup byte limit.",
            );
        }

        documents.push(document);
    }

    return Object.freeze(documents);
}

export async function readAmlDocument(path: string): Promise<AmlDocument> {
    return parseAml(await readText(path), path);
}

export type PackageInputError = PackageFileError | PackageImportError | AmlParseError;

interface PackageFileOptions {
    readonly allowEmptyDirectories?: boolean;
    readonly onError?: (error: PackageInputError) => void;
}

/** Resolve inputs without parsing AML, so automatic and additional paths can share discovery. */
export async function resolvePackageFiles(
    sources: readonly PackageSource[],
    options: PackageFileOptions = {},
): Promise<readonly string[]> {
    return await new PackageFiles(options).resolve(sources);
}

class PackageFiles {
    private readonly files: string[] = [];
    private readonly seen = new Set<string>();
    private readonly manifests = new Set<string>();
    private visited = 0;

    constructor(private readonly options: PackageFileOptions) {}

    async resolve(sources: readonly PackageSource[]): Promise<readonly string[]> {
        const pending = sources.map((source) => source.path).reverse();

        while (pending.length > 0) {
            this.checkDiscovery(pending.length);
            const path = pending.pop();

            if (path === undefined) {
                throw new Error("A source must exist while package discovery is pending.");
            }

            try {
                const children = await this.collectSource(path);

                for (let index = children.length - 1; index >= 0; index -= 1) {
                    const child = children[index];

                    if (child) {
                        if (pending.length >= setupFilesMax) {
                            throw new PackageFileError(
                                "PackageReadFailed",
                                path,
                                "Package discovery exceeded its pending-file limit.",
                            );
                        }

                        pending.push(child);
                    }
                }
            } catch (error) {
                this.reportError(error);
            }
        }

        return Object.freeze(this.files);
    }

    private checkDiscovery(pending: number): void {
        this.visited += 1;

        if (
            this.visited > setupFilesMax ||
            pending > setupFilesMax ||
            this.files.length > setupFilesMax
        ) {
            throw new PackageFileError(
                "PackageReadFailed",
                "<package inputs>",
                "Package discovery exceeded its work limit.",
            );
        }
    }

    private reportError(error: unknown): void {
        if (
            !this.options.onError ||
            !(
                error instanceof PackageFileError ||
                error instanceof PackageImportError ||
                error instanceof AmlParseError
            )
        ) {
            throw error;
        }

        this.options.onError(error);
    }

    private async addFile(path: string): Promise<void> {
        const canonical = await fileOperation(path, () => realpath(path));

        if (this.seen.has(canonical)) {
            throw new PackageFileError(
                "DuplicatePackageFile",
                path,
                "This XML file was supplied more than once.",
            );
        }

        this.seen.add(canonical);
        this.files.push(canonical);
    }

    private async collectDirectory(path: string): Promise<void> {
        const discovered: string[] = [];
        const pending = [path];

        while (pending.length > 0) {
            const directory = pending.pop();

            if (directory === undefined) {
                throw new Error("A directory must exist while discovery is pending.");
            }

            try {
                const entries = await fileOperation(directory, () =>
                    readdir(directory, { withFileTypes: true }),
                );
                entries.sort((left, right) => comparePaths(left.name, right.name));

                for (const entry of entries) {
                    const child = join(directory, entry.name);

                    try {
                        if (entry.isSymbolicLink()) {
                            throw new PackageFileError(
                                "UnsupportedSymlink",
                                child,
                                "Supply real files and directories instead of symbolic links.",
                            );
                        }

                        if (entry.isDirectory()) {
                            pending.push(child);
                        } else if (entry.isFile() && isXmlFile(child)) {
                            discovered.push(child);
                        } else if (!entry.isFile()) {
                            throw new PackageFileError(
                                "UnsupportedPackageEntry",
                                child,
                                "Only regular files and directories are supported.",
                            );
                        }
                    } catch (error) {
                        this.reportError(error);
                    }
                }
            } catch (error) {
                this.reportError(error);
            }
        }

        if (discovered.length === 0 && !this.options.allowEmptyDirectories) {
            throw new PackageFileError(
                "EmptyPackageDirectory",
                path,
                "No XML files were found in the supplied directory.",
            );
        }

        for (const file of discovered.sort(comparePaths)) {
            try {
                await this.addFile(file);
            } catch (error) {
                this.reportError(error);
            }
        }
    }

    private async collectSource(sourcePath: string): Promise<readonly string[]> {
        if (!sourcePath.trim()) {
            throw new PackageFileError(
                "MissingPackagePath",
                sourcePath,
                "A package source path is required.",
            );
        }

        const path = resolve(sourcePath);
        const status = await fileOperation(path, () => lstat(path));

        if (status.isSymbolicLink()) {
            throw new PackageFileError(
                "UnsupportedSymlink",
                path,
                "Supply a real file or directory instead of a symbolic link.",
            );
        }

        if (status.isDirectory()) {
            await this.collectDirectory(path);
        } else if (status.isFile() && extname(path).toLowerCase() === ".mf") {
            return await this.collectManifest(path);
        } else if (status.isFile() && isXmlFile(path)) {
            await this.addFile(path);
        } else {
            throw new PackageFileError(
                "UnsupportedPackageFile",
                path,
                "Supply an XML file, imports.mf manifest, package root, or Import directory.",
            );
        }

        return [];
    }

    private async collectManifest(path: string): Promise<readonly string[]> {
        const canonical = await fileOperation(path, () => realpath(path));

        if (this.manifests.has(canonical)) {
            throw new PackageFileError(
                "DuplicatePackageManifest",
                path,
                "This manifest was supplied more than once or contains a recursive path.",
            );
        }

        this.manifests.add(canonical);
        const paths = manifestPaths(await readText(path), path);

        if (paths.length === 0) {
            throw new PackageFileError(
                "EmptyPackageManifest",
                path,
                "The manifest contains no packages.",
            );
        }

        return paths;
    }
}

export async function readText(path: string): Promise<string> {
    try {
        return await fileOperation(path, () => readTextFile(path));
    } catch (error) {
        if (error instanceof PackageFileError && error.cause instanceof TextEncodingError) {
            throw new PackageFileError(
                "InvalidPackageEncoding",
                path,
                "Package XML must contain valid UTF-8.",
                { cause: error.cause },
            );
        }

        throw error;
    }
}

function isXmlFile(path: string): boolean {
    return extname(path).toLowerCase() === ".xml";
}

function comparePaths(left: string, right: string): number {
    if (left === right) {
        return 0;
    }

    if (left < right) {
        return -1;
    }

    return 1;
}

async function fileOperation<T>(path: string, operation: () => Promise<T>): Promise<T> {
    try {
        return await operation();
    } catch (error) {
        throw new PackageFileError(
            "PackageReadFailed",
            path,
            "Could not read the supplied package input.",
            { cause: error },
        );
    }
}
