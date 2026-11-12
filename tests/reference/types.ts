import type { CapabilityId, ExecutionOutcome, StoredItem } from "../../src/index.js";
import type { ItemPayload } from "../../src/items/item.js";

export interface WatchedType {
    readonly type: string;
    readonly keys: readonly string[];
    readonly properties: readonly string[];
    readonly sourceIds?: readonly string[];
}

export interface ReferenceStep {
    readonly name: string;
    readonly aml: string;
}

export interface ReferenceCase {
    readonly id: string;
    readonly capabilities: readonly CapabilityId[];
    readonly steps: readonly ReferenceStep[];
    readonly check: (observation: Observation) => void;
}

export interface EventObservation {
    readonly method: string;
    readonly event: string;
    readonly context: ItemPayload;
}

export interface StepObservation {
    readonly name: string;
    readonly request: ItemPayload;
    readonly response: ItemPayload;
    readonly outcome: ExecutionOutcome;
    readonly events: readonly EventObservation[];
    readonly state: readonly StoredItem[];
}

export interface Observation {
    readonly initial: readonly StoredItem[];
    readonly steps: readonly StepObservation[];
}

export interface CaseRun {
    readonly caseId: string;
    readonly inputHash: string;
    readonly observation: Observation;
}

export interface NativeEvidence extends CaseRun {
    readonly schemaVersion: 1;
    readonly source: "native-aras";
    readonly profile: { readonly release: string; readonly build: string };
    readonly recordedAt: string;
    readonly review: {
        readonly reviewer: string;
        readonly reviewedAt: string;
        readonly evidence: string;
    };
}

export enum ComparisonStatus {
    Pending = "PENDING_NATIVE_REFERENCE",
    Matched = "MATCHED",
    Different = "DIFFERENT",
    Stale = "STALE_REFERENCE",
    Invalid = "INVALID_REFERENCE",
}

export interface Difference {
    readonly path: string;
    readonly expected: unknown;
    readonly actual: unknown;
}

export interface ReferenceResult {
    readonly caseId: string;
    readonly contractPassed: boolean;
    readonly comparison: ComparisonStatus;
    readonly differences: readonly Difference[];
    readonly contractError?: string;
    readonly native?: Pick<NativeEvidence, "profile" | "recordedAt" | "review">;
    readonly diagnostic?: string;
}
