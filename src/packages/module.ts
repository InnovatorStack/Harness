import { defineOperation } from "../core/operation.js";
import type { HarnessModule } from "../core/types.js";
import type { HarnessStorage } from "../storage/types.js";
import { PackageImporter } from "./importer.js";
import type { PackageLoadReport } from "./importer.js";
import type { AmlDocument } from "./types.js";

export const importPackageDocuments = defineOperation<readonly AmlDocument[], PackageLoadReport>(
    "packages.import",
);

export const importSetupDocuments = defineOperation<
    {
        readonly packages: readonly AmlDocument[];
        readonly fixtures: readonly AmlDocument[];
    },
    PackageLoadReport
>("packages.setup");

export function createPackageModule(storage: HarnessStorage): HarnessModule {
    return {
        id: "packages",

        setup(registrar) {
            registrar.handleSync(importPackageDocuments, (documents) =>
                new PackageImporter(storage).import(documents),
            );
            registrar.handleSync(importSetupDocuments, ({ packages, fixtures }) =>
                new PackageImporter(storage).import(
                    [...packages, ...fixtures],
                    new Set(fixtures.map((document) => document.file)),
                ),
            );
        },
    };
}
