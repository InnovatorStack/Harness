import { dirname, resolve } from "node:path";

import type { SourceLocation } from "../diagnostics/source-location.js";
import { PackageImportError } from "./diagnostics.js";
import { childElements, textContent } from "./elements.js";
import { parseXml } from "./parser.js";
import type { AmlElement } from "./types.js";

interface ManifestPackage {
    readonly name: string;
    readonly path: string;
    readonly dependencies: readonly string[];
    readonly source: SourceLocation;
}

/** An Innovator import manifest declares packages, paths, and dependency order. */
export function manifestPaths(xml: string, file: string): readonly string[] {
    const root = parseXml(xml, file);

    if (root.name !== "imports") {
        throw new PackageImportError(
            "UNSUPPORTED_MANIFEST",
            "Expected an <imports> package manifest.",
            root.source,
        );
    }

    const packages = readManifestPackages(root);

    return orderManifestPackages(packages).map((entry) =>
        resolve(dirname(file), entry.path.replaceAll("\\", "/")),
    );
}

function readManifestPackages(root: AmlElement): ReadonlyMap<string, ManifestPackage> {
    const packages = new Map<string, ManifestPackage>();

    for (const element of childElements(root)) {
        const name = element.attributes.name;
        const path = element.attributes.path;

        if (
            element.name !== "package" ||
            !name?.trim() ||
            !path?.trim() ||
            textContent(element).trim()
        ) {
            throw new PackageImportError(
                "INVALID_MANIFEST",
                "Each manifest package requires a name and path.",
                element.source,
            );
        }

        if (packages.has(name)) {
            throw new PackageImportError(
                "DUPLICATE_PACKAGE",
                `Package '${name}' is declared more than once.`,
                element.source,
            );
        }

        const dependencies: string[] = [];

        for (const dependency of childElements(element)) {
            if (
                dependency.name !== "dependson" ||
                !dependency.attributes.name?.trim() ||
                childElements(dependency).length ||
                textContent(dependency).trim()
            ) {
                throw new PackageImportError(
                    "INVALID_MANIFEST",
                    'Package dependencies must use <dependson name="…" />.',
                    dependency.source,
                );
            }

            dependencies.push(dependency.attributes.name);
        }

        packages.set(name, { name, path, dependencies, source: element.source });
    }

    return packages;
}

interface ManifestFrame {
    readonly entry: ManifestPackage;
    nextDependency: number;
}

function orderManifestPackages(
    packages: ReadonlyMap<string, ManifestPackage>,
): readonly ManifestPackage[] {
    const ordered: ManifestPackage[] = [];
    const completed = new Set<string>();
    const visiting = new Set<string>();
    const stack: ManifestFrame[] = [];

    for (const entry of packages.values()) {
        if (completed.has(entry.name)) {
            continue;
        }

        stack.push({ entry, nextDependency: 0 });
        visiting.add(entry.name);

        while (stack.length > 0) {
            const frame = stack.at(-1);

            if (!frame) {
                throw new Error("A frame must exist while manifest ordering is pending.");
            }

            const name = frame.entry.dependencies[frame.nextDependency];

            if (name === undefined) {
                stack.pop();
                visiting.delete(frame.entry.name);
                completed.add(frame.entry.name);
                ordered.push(frame.entry);
                continue;
            }

            frame.nextDependency += 1;
            const dependency = packages.get(name);

            if (!dependency) {
                throw new PackageImportError(
                    "MISSING_PACKAGE",
                    `Package '${frame.entry.name}' depends on undeclared package '${name}'. Supply it in this manifest.`,
                    frame.entry.source,
                    { reference: { type: "PackageDefinition", name } },
                );
            }

            if (completed.has(name)) {
                continue;
            }

            if (visiting.has(name)) {
                const chain = [...stack.map((frame) => frame.entry.name), name].join(" → ");

                throw new PackageImportError(
                    "CYCLIC_PACKAGES",
                    `Package dependency cycle: ${chain}.`,
                    dependency.source,
                );
            }

            visiting.add(name);
            stack.push({ entry: dependency, nextDependency: 0 });
        }
    }

    return ordered;
}
