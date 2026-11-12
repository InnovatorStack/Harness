import type { CatalogEntry, HarnessStorage } from "../storage/types.js";
import type { PackageMethodDeclaration, PackageSqlDeclaration } from "../verification/types.js";

/** Resolve declarations against the actual imported catalog, including patches and generated
 * IDs. */
export function resolveDeclaration(
    storage: HarnessStorage,
    type: "Method" | "SQL",
    declaration: PackageMethodDeclaration | PackageSqlDeclaration,
): CatalogEntry | undefined {
    const entries = storage.listCatalogEntries(type);

    if (declaration.id) {
        return entries.find((entry) => entry.id.toLowerCase() === declaration.id?.toLowerCase());
    }

    const sameSource = entries.find(
        (entry) =>
            entry.source.file === declaration.source.file &&
            entry.source.path === declaration.source.path,
    );

    if (sameSource) {
        return sameSource;
    }

    const sameName = entries.filter(
        (entry) =>
            typeof entry.properties.name === "string" &&
            entry.properties.name.toLowerCase() === declaration.name?.toLowerCase(),
    );

    if (sameName.length === 1) {
        return sameName[0];
    }

    return undefined;
}
