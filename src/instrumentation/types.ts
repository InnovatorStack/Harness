import type { CapabilityId } from "../compatibility/capabilities.js";
import type { ExecutionInjection } from "../controls/failure-types.js";
import type { SourceLocation } from "../diagnostics/source-location.js";
import type { MockValue } from "../mocks/types.js";
import type { SourceDefinition } from "../platform/trace.js";
import type { StoredItem } from "../storage/types.js";

export enum ExecutionOutcome {
    Committed = "COMMITTED",
    RolledBack = "ROLLED_BACK",
    Unknown = "UNKNOWN",
}

export enum ExecutionStatus {
    Succeeded = "SUCCEEDED",
    Failed = "FAILED",
}

export enum ExecutionMode {
    Real = "REAL",
    Mocked = "MOCKED",
}

export enum ExecutionKind {
    Operation = "OPERATION",
    Aml = "AML",
    Action = "ACTION",
    Method = "METHOD",
    Sql = "SQL",
}

export type ExecutionValue =
    | null
    | boolean
    | number
    | string
    | readonly ExecutionValue[]
    | {
          readonly [name: string]: ExecutionValue;
      };

export interface ExecutionLocation {
    readonly executionId: string;
    readonly name: string;
    readonly source?: SourceLocation;
}

export interface ExecutionFailure {
    readonly name: string;
    readonly message: string;
    readonly code?: string;
    readonly capability?: CapabilityId;
    readonly source?: SourceLocation;
    readonly callChain: readonly ExecutionLocation[];
    readonly causes: readonly ExecutionFailure[];
}

export interface ExecutionEvent {
    readonly name: string;
    readonly kind: "event" | "authorization";
    readonly source?: SourceLocation;
}

export type ExecutionDefinition = SourceDefinition;

export interface ExecutionCall extends ExecutionLocation {
    readonly parentExecutionId?: string;
    readonly operation: string;
    readonly kind: ExecutionKind;
    readonly status: ExecutionStatus;
    readonly mode: ExecutionMode;
    readonly durationMs: number;
    readonly definition?: ExecutionDefinition;
    readonly sourceHash?: string;
    /** Evidence that the executor began source evaluation, separate from dispatch or
     * compilation. */
    readonly executed: boolean;
    readonly input?: ExecutionValue;
    readonly result?: ExecutionValue;
    readonly via?: ExecutionEvent;
    readonly events: readonly ExecutionEvent[];
    readonly error?: ExecutionFailure;
    readonly children: readonly ExecutionCall[];
}

export interface ExecutionChange {
    readonly executionId: string;
    readonly name: string;
    readonly before?: StoredItem;
    readonly after?: StoredItem;
    readonly outcome: ExecutionOutcome;
}

export interface ExecutionMock {
    readonly executionId: string;
    readonly name: string;
    readonly definition: string;
    readonly parameters?: Readonly<Record<string, MockValue>>;
    readonly responseFile?: string;
    readonly responseHash: string;
}

export interface ExecutionTruncation {
    readonly calls: number;
    readonly changes: number;
    readonly mocks: number;
    readonly failures: number;
    readonly events: number;
    readonly snapshots: number;
}

/** A completed request. A successful nested call can still belong to a rolled-back request. */
export interface ExecutionReport {
    readonly id: string;
    readonly requestId: string;
    readonly startedAt: string;
    readonly durationMs: number;
    readonly outcome: ExecutionOutcome;
    readonly calls: readonly ExecutionCall[];
    readonly changes: readonly ExecutionChange[];
    readonly mocks: readonly ExecutionMock[];
    readonly failures: readonly ExecutionInjection[];
    readonly error?: ExecutionFailure;
    readonly truncated: boolean;
    readonly omitted: ExecutionTruncation;
}
