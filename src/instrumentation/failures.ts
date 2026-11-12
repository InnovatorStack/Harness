import type { CapabilityId } from "../compatibility/capabilities.js";
import type { SourceLocation } from "../diagnostics/source-location.js";
import { ApplicationError, PlatformError } from "../platform/errors.js";
import type { Snapshots } from "./snapshots.js";
import type { ExecutionFailure, ExecutionLocation } from "./types.js";

const causeDepthMax = 4;
const causeCountMax = 8;

interface FailureDraft {
    name: string;
    message: string;
    code?: string;
    capability?: CapabilityId;
    source?: SourceLocation;
    callChain: readonly ExecutionLocation[];
    causes: FailureDraft[];
}

interface PendingFailure {
    readonly error: unknown;
    readonly depth: number;
    readonly failure: FailureDraft;
}

/** Preserve the diagnostic tree without recursion or unbounded cause expansion. */
export function describeFailure(
    error: unknown,
    chain: readonly ExecutionLocation[],
    snapshots: Snapshots,
    depth = 0,
): ExecutionFailure {
    const root = failureDraft(error, chain, snapshots);
    const pending: PendingFailure[] = [{ error, depth, failure: root }];
    const failures = [root];

    while (pending.length > 0) {
        const current = pending.pop();

        if (!current) {
            throw new Error("A pending failure must exist while the stack is nonempty.");
        }

        const causes = failureCauses(current.error);

        if (current.depth >= causeDepthMax) {
            if (causes.length > 0) {
                snapshots.omitted += 1;
            }

            continue;
        }

        snapshots.omitted += Math.max(0, causes.length - causeCountMax);

        for (const cause of causes.slice(0, causeCountMax)) {
            const failure = failureDraft(cause, chain, snapshots);
            current.failure.causes.push(failure);
            failures.push(failure);
            pending.push({ error: cause, depth: current.depth + 1, failure });
        }
    }

    for (const failure of failures.reverse()) {
        Object.freeze(failure.causes);
        Object.freeze(failure);
    }

    return root;
}

function failureDraft(
    error: unknown,
    chain: readonly ExecutionLocation[],
    snapshots: Snapshots,
): FailureDraft {
    let name = "Error";
    let originalMessage: string;

    if (error instanceof Error) {
        name = error.name;
        originalMessage = error.message;
    } else {
        originalMessage = String(error);
    }

    let message = "Error message omitted by snapshot limits.";
    const captured = snapshots.value(originalMessage);

    if (typeof captured === "string") {
        message = captured;
    }

    const failure: FailureDraft = {
        name,
        message,
        callChain: Object.freeze([...chain]),
        causes: [],
    };

    if (error instanceof Error && "code" in error && typeof error.code === "string") {
        failure.code = error.code;
    } else if (error instanceof ApplicationError) {
        failure.code = error.item.getErrorCode();
    }

    let source = failureSource(chain);

    if (error instanceof PlatformError) {
        if (error.capability !== undefined) {
            failure.capability = error.capability;
        }

        if (error.source) {
            source = error.source;
        }
    }

    if (source) {
        failure.source = Object.freeze({ ...source });
    }

    return failure;
}

function failureSource(chain: readonly ExecutionLocation[]): SourceLocation | undefined {
    for (let index = chain.length - 1; index >= 0; index -= 1) {
        const source = chain[index]?.source;

        if (source) {
            return source;
        }
    }

    return undefined;
}

function failureCauses(error: unknown): readonly unknown[] {
    if (error instanceof AggregateError) {
        return error.errors;
    }

    if (error instanceof Error && error.cause !== undefined) {
        return [error.cause];
    }

    return [];
}
