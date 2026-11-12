import type { SourceLocation } from "../diagnostics/source-location.js";
import type { HarnessOptions } from "../harness/configuration.js";
import type { PackageReference } from "../packages/diagnostics.js";

export enum PackageIssueCode {
    InvalidConfiguration = "INVALID_CONFIGURATION",
    InvalidInput = "INVALID_INPUT",
    InvalidXml = "INVALID_XML",
    InvalidDefinition = "INVALID_DEFINITION",
    MissingDependency = "MISSING_DEPENDENCY",
    Conflict = "CONFLICT",
    UnsupportedFeature = "UNSUPPORTED_FEATURE",
    ImportFailed = "IMPORT_FAILED",
}

export interface PackageVerificationOptions extends Pick<
    HarnessOptions,
    "cwd" | "config" | "packages"
> {}

export interface PackageVerificationIssue {
    readonly code: PackageIssueCode;
    readonly message: string;
    readonly causeCode?: string;
    readonly source?: SourceLocation;
    readonly path?: string;
    readonly relatedSources: readonly SourceLocation[];
    readonly reference?: PackageReference;
}

/** One supplied declaration. Patches remain separate from additions in the inventory. */
export interface PackageMethodDeclaration {
    readonly action: string;
    readonly id?: string;
    readonly name?: string;
    readonly language?: string;
    readonly codeHash?: string;
    readonly source: SourceLocation;
}

export interface PackageSqlDeclaration {
    readonly action: string;
    readonly id?: string;
    readonly name?: string;
    readonly bodyHashes: Readonly<Record<string, string>>;
    readonly source: SourceLocation;
}

export interface PackageVerificationReport {
    /** Whether the supplied package XML imports with Harness's built-in metadata and importer. */
    readonly canImport: boolean;
    readonly issues: readonly PackageVerificationIssue[];
    readonly documents: readonly {
        readonly path: string;
        readonly sha256: string;
    }[];
    readonly methods: readonly PackageMethodDeclaration[];
    readonly sql: readonly PackageSqlDeclaration[];
}

export type { PackageReference } from "../packages/diagnostics.js";
