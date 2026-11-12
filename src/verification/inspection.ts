import { errorMessage } from "../core/errors.js";
import { setupBytesMax } from "../core/limits.js";
import { loadPackageSettings } from "../harness/configuration.js";
import type { HarnessOptions, PackageConfiguration } from "../harness/configuration.js";
import { PackageFileError, readAmlDocument } from "../packages/files.js";
import { PackageImporter } from "../packages/importer.js";
import type { AmlDocument } from "../packages/types.js";
import { SqliteStorage } from "../storage/sqlite/storage.js";
import { verificationIssues } from "./diagnostics.js";
import { inventory } from "./inventory.js";
import { PackageIssueCode } from "./types.js";
import type { PackageVerificationIssue, PackageVerificationReport } from "./types.js";

/** A private import transaction, shared by metadata and execution preflight checks. */
export class PackageInspection implements Disposable {
    constructor(
        readonly storage: SqliteStorage,
        readonly report: PackageVerificationReport,
        readonly configuration: PackageConfiguration | undefined,
    ) {}

    [Symbol.dispose](): void {
        this.storage.close();
    }
}

export async function inspectPackages(options: HarnessOptions): Promise<PackageInspection> {
    const issues: PackageVerificationIssue[] = [];
    const documents: AmlDocument[] = [];
    const storage = new SqliteStorage();

    try {
        storage.transactions.begin();
        new PackageImporter(storage).import([]);
        let configuration: PackageConfiguration;

        try {
            configuration = await loadPackageSettings(options, (error) => {
                issues.push(...verificationIssues(error));
            });
        } catch (error) {
            issues.push(
                Object.freeze({
                    code: PackageIssueCode.InvalidConfiguration,
                    message: errorMessage(error),
                    relatedSources: Object.freeze([]),
                }),
            );

            return new PackageInspection(storage, report(documents, issues), undefined);
        }

        let bytes = 0;

        for (const path of configuration.packages) {
            try {
                const document = await readAmlDocument(path);
                bytes += document.xml.length * 3;

                if (bytes > setupBytesMax) {
                    throw new PackageFileError(
                        "PackageInputLimit",
                        path,
                        "Combined package input exceeds its byte limit.",
                    );
                }

                documents.push(document);
            } catch (error) {
                issues.push(...verificationIssues(error));
            }
        }

        try {
            new PackageImporter(storage).import(documents);
        } catch (error) {
            issues.push(...verificationIssues(error));
        }

        return new PackageInspection(storage, report(documents, issues), configuration);
    } catch (error) {
        try {
            storage.close();
        } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], "Inspection and cleanup failed.", {
                cause: cleanupError,
            });
        }

        throw error;
    }
}

function report(
    documents: readonly AmlDocument[],
    issues: readonly PackageVerificationIssue[],
): PackageVerificationReport {
    return Object.freeze({
        canImport: issues.length === 0,
        issues: Object.freeze([...issues]),
        documents: Object.freeze(
            documents.map((document) =>
                Object.freeze({ path: document.file, sha256: document.sha256 }),
            ),
        ),
        ...inventory(documents),
    });
}
