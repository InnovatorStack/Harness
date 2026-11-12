import type { SourceLocation } from "../diagnostics/source-location.js";
import type { HarnessOptions } from "../harness/configuration.js";
import type {
    ExecutionReport,
    ExecutionMode,
    ExecutionStatus,
    ExecutionOutcome,
} from "../instrumentation/types.js";
import type { MethodDefinition } from "../methods/types.js";
import type { MockValue } from "../mocks/types.js";
import type {
    PackageMethodDeclaration,
    PackageSqlDeclaration,
    PackageVerificationReport,
} from "../verification/types.js";
import type { CapabilityDescriptor, CapabilityId } from "./capabilities.js";

export interface CompatibilityOptions extends HarnessOptions {
    /** Compile effective C# source unless an unconditional mock replaces it. Never invoke it. */
    readonly compile?: boolean;
    readonly executions?: readonly ExecutionReport[];
}

export enum CompatibilityIssueCode {
    PackageImportFailed = "PACKAGE_IMPORT_FAILED",
    UnsupportedCapability = "UNSUPPORTED_CAPABILITY",
    ExecutorUnavailable = "EXECUTOR_UNAVAILABLE",
    CompilationFailed = "COMPILATION_FAILED",
    InvalidDefinition = "INVALID_DEFINITION",
    InvalidMocks = "INVALID_MOCKS",
    ConditionalMock = "CONDITIONAL_MOCK",
    AmbiguousMock = "AMBIGUOUS_MOCK",
    ExtensionNotInspected = "EXTENSION_NOT_INSPECTED",
    AuthorizationRequired = "AUTHORIZATION_REQUIRED",
    ExecutionSourceMismatch = "EXECUTION_SOURCE_MISMATCH",
    ExecutionEvidenceTruncated = "EXECUTION_EVIDENCE_TRUNCATED",
}

export enum IssueSeverity {
    Error = "ERROR",
    Warning = "WARNING",
    Information = "INFORMATION",
}

export interface CompatibilityIssue {
    readonly code: CompatibilityIssueCode;
    readonly severity: IssueSeverity;
    readonly message: string;
    readonly capability?: CapabilityId;
    /** Original runtime diagnostic, when the same gap can be encountered during execution. */
    readonly causeCode?: string;
    readonly source?: SourceLocation;
}

export enum ExecutorStatus {
    Available = "AVAILABLE",
    Missing = "MISSING",
    Disabled = "DISABLED",
    Unavailable = "UNAVAILABLE",
    Unknown = "UNKNOWN",
}

export interface ExecutorCheck {
    readonly status: ExecutorStatus;
    readonly message?: string;
}

export enum MockCoverage {
    None = "NONE",
    Conditional = "CONDITIONAL",
    Unconditional = "UNCONDITIONAL",
    Ambiguous = "AMBIGUOUS",
    Unknown = "UNKNOWN",
}

export interface MockRuleDescription {
    readonly definition: string;
    readonly when: Readonly<Record<string, MockValue>>;
    readonly layer: number;
    readonly responseFile?: string;
    readonly responseHash: string;
}

export interface MockCheck {
    readonly coverage: MockCoverage;
    readonly rules: readonly MockRuleDescription[];
}

export enum CompilationStatus {
    NotRequested = "NOT_REQUESTED",
    Compiled = "COMPILED",
    Failed = "FAILED",
    SkippedMock = "SKIPPED_MOCK",
    Unavailable = "UNAVAILABLE",
    Unsupported = "UNSUPPORTED",
    Unresolved = "UNRESOLVED",
}

export interface CompilationCheck {
    readonly status: CompilationStatus;
    /** The effective source that was checked; never a claim about an overwritten declaration. */
    readonly sourceHash?: string;
    readonly message?: string;
}

export interface MethodCompatibility {
    readonly declaration: PackageMethodDeclaration;
    readonly definition?: Omit<MethodDefinition, "code">;
    readonly executor: ExecutorCheck;
    readonly mocks: MockCheck;
    readonly compilation: CompilationCheck;
    readonly issues: readonly CompatibilityIssue[];
    readonly executed: boolean;
    readonly observations: readonly SourceExecutionObservation[];
    readonly referenceVerified: boolean;
}

export interface SqlCompatibility {
    readonly declaration: PackageSqlDeclaration;
    readonly definition?: {
        readonly id: string;
        readonly name: string;
        readonly source: SourceLocation;
        readonly bodyHashes: Readonly<Record<string, string>>;
    };
    readonly executor: ExecutorCheck;
    readonly mocks: MockCheck;
    readonly issues: readonly CompatibilityIssue[];
    readonly executed: boolean;
    readonly observations: readonly SourceExecutionObservation[];
    readonly referenceVerified: boolean;
}

export interface SourceExecutionObservation {
    readonly reportId: string;
    readonly executionId: string;
    readonly mode: ExecutionMode;
    readonly status: ExecutionStatus;
    readonly outcome: ExecutionOutcome;
    readonly executed: boolean;
    readonly sourceHash?: string;
}

export interface CompatibilityReport {
    readonly packages: PackageVerificationReport;
    readonly capabilities: readonly CapabilityDescriptor[];
    readonly methods: readonly MethodCompatibility[];
    readonly sql: readonly SqlCompatibility[];
    readonly issues: readonly CompatibilityIssue[];
    /** Dynamic names, generated AML, branch coverage and external effects are not statically
     * proven. */
    readonly limitations: readonly string[];
}
