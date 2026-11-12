import { dataNodesMax } from "../core/limits.js";
import { PackageImportError } from "../packages/diagnostics.js";
import { PackageFileError } from "../packages/files.js";
import { AmlParseError } from "../packages/parser.js";
import { PackageIssueCode } from "./types.js";
import type { PackageVerificationIssue } from "./types.js";

const missingDependencies = new Set([
    "MISSING_REFERENCE",
    "MISSING_ITEM_TYPE",
    "MISSING_PROPERTY_OWNER",
    "MISSING_PACKAGE",
    "UNKNOWN_PROPERTY",
]);

const conflicts = new Set([
    "AMBIGUOUS_REFERENCE",
    "AMBIGUOUS_IMPORT_ORDER",
    "DUPLICATE_ITEM",
    "DUPLICATE_ITEM_TYPE",
    "DUPLICATE_PROPERTY",
    "DUPLICATE_PACKAGE",
    "CYCLIC_SELECTOR",
    "CYCLIC_IMPORT_ORDER",
    "CYCLIC_PACKAGES",
    "DuplicatePackageFile",
    "DuplicatePackageManifest",
]);

function issueCode(code: string, fallback: PackageIssueCode): PackageIssueCode {
    if (missingDependencies.has(code)) {
        return PackageIssueCode.MissingDependency;
    }

    if (conflicts.has(code) || code.startsWith("CONFLICTING_")) {
        return PackageIssueCode.Conflict;
    }

    if (code.startsWith("UNSUPPORTED_") || code.startsWith("Unsupported")) {
        return PackageIssueCode.UnsupportedFeature;
    }

    if (code.startsWith("INVALID_") || code === "ID_MISMATCH" || code === "REPEATED_PROPERTY") {
        return PackageIssueCode.InvalidDefinition;
    }

    return fallback;
}

/** Unknown failures remain exceptions; they must not become ordinary package diagnostics. */
export function verificationIssues(error: unknown): readonly PackageVerificationIssue[] {
    const pending: unknown[] = [error];
    const seen = new Set<AggregateError>();
    const issues: PackageVerificationIssue[] = [];

    while (pending.length > 0) {
        if (issues.length + pending.length > dataNodesMax) {
            throw new TypeError("Package diagnostics exceeded their cause limit.");
        }

        const error = pending.pop();

        if (error instanceof AggregateError) {
            if (seen.has(error)) {
                throw new TypeError("Package diagnostics cannot contain circular AggregateErrors.");
            }

            seen.add(error);

            if (pending.length + error.errors.length > dataNodesMax) {
                throw new TypeError("Package diagnostics exceeded their cause limit.");
            }

            for (let index = error.errors.length - 1; index >= 0; index -= 1) {
                pending.push(error.errors[index]);
            }
        } else {
            issues.push(...verificationIssue(error));
        }
    }

    return issues;
}

function verificationIssue(error: unknown): readonly PackageVerificationIssue[] {
    if (error instanceof PackageImportError) {
        return [
            Object.freeze({
                code: issueCode(error.code, PackageIssueCode.ImportFailed),
                causeCode: error.code,
                message: error.message,
                source: error.source,
                relatedSources: error.relatedSources,
                ...(error.reference ? { reference: error.reference } : {}),
            }),
        ];
    }

    if (error instanceof AmlParseError) {
        return [
            Object.freeze({
                code: issueCode(error.code, PackageIssueCode.InvalidXml),
                causeCode: error.code,
                message: error.message,
                source: error.source,
                relatedSources: Object.freeze([]),
            }),
        ];
    }

    if (error instanceof PackageFileError) {
        return [
            Object.freeze({
                code: issueCode(error.code, PackageIssueCode.InvalidInput),
                causeCode: error.code,
                message: error.message,
                path: error.path,
                relatedSources: Object.freeze([]),
            }),
        ];
    }

    throw error;
}
