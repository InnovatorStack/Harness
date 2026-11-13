import { readMethodFiles } from "../harness/method-files.js";
import { methodFileLocation } from "../methods/sources.js";
import { PlatformCatalog } from "../platform/catalog.js";
import type { PackageInspection } from "../verification/inspection.js";
import type { PackageMethodDeclaration } from "../verification/types.js";

/** Keep package declarations intact while also inspecting explicitly configured local Methods. */
export async function inspectMethodSources(inspection: PackageInspection) {
    const configuration = inspection.configuration;
    const files = configuration
        ? await readMethodFiles(configuration.directory, configuration.settings.methods)
        : [];
    const catalog = new PlatformCatalog(inspection.storage, files);
    const declarations: PackageMethodDeclaration[] = [...inspection.report.methods];
    const packagedNames = new Set(
        inspection.storage
            .listCatalogEntries("Method")
            .map((entry) => String(entry.properties.name).toLowerCase()),
    );

    for (const file of files) {
        if (packagedNames.has(file.name.toLowerCase())) {
            continue;
        }

        const entry = catalog.methodEntry(file.name);
        declarations.push(
            Object.freeze({
                action: "source",
                ...(entry ? { id: entry.id } : {}),
                name: file.name,
                language: "C#",
                source: methodFileLocation(file),
            }),
        );
    }

    return { catalog, declarations };
}
