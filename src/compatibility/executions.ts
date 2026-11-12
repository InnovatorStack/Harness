import { dataNodesMax } from "../core/limits.js";
import type { SourceLocation } from "../diagnostics/source-location.js";
import { ExecutionMode } from "../instrumentation/types.js";
import type { ExecutionCall, ExecutionReport } from "../instrumentation/types.js";
import { CompatibilityIssueCode, IssueSeverity } from "./types.js";
import type { CompatibilityIssue, SourceExecutionObservation } from "./types.js";

interface CallEvidence {
    readonly report: ExecutionReport;
    readonly call: ExecutionCall;
}

/** Match execution to effective source, not a Method name or a successful mock response. */
export class ExecutionEvidence {
    private readonly calls = new Map<string, CallEvidence[]>();
    readonly issues: CompatibilityIssue[] = [];

    constructor(reports: readonly ExecutionReport[]) {
        const seen = new Set<string>();
        let callCount = 0;

        for (const report of reports) {
            if (seen.has(report.id)) {
                continue;
            }

            seen.add(report.id);

            if (report.truncated) {
                this.issues.push(
                    Object.freeze({
                        code: CompatibilityIssueCode.ExecutionEvidenceTruncated,
                        severity: IssueSeverity.Warning,
                        message: `Execution '${report.id}' is truncated; its retained calls provide partial evidence.`,
                    }),
                );
            }

            const pending = [...report.calls].reverse();
            const visited = new Set<ExecutionCall>();

            while (pending.length > 0) {
                const call = pending.pop();

                if (!call) {
                    continue;
                }

                callCount += 1;

                if (visited.has(call) || callCount > dataNodesMax) {
                    throw new TypeError(
                        "Execution evidence exceeds its call limit or contains a cycle.",
                    );
                }

                visited.add(call);

                for (let index = call.children.length - 1; index >= 0; index -= 1) {
                    const child = call.children[index];

                    if (child) {
                        pending.push(child);
                    }
                }

                if (!call.definition) {
                    continue;
                }

                const key = `${call.definition.type}:${call.definition.id.toLowerCase()}`;
                let entries = this.calls.get(key);

                if (!entries) {
                    entries = [];
                    this.calls.set(key, entries);
                }

                entries.push({ report, call });
            }
        }
    }

    observations(
        type: "Method" | "SQL",
        id: string,
        sourceHash: string | undefined,
        source: SourceLocation,
    ): readonly SourceExecutionObservation[] {
        const observations: SourceExecutionObservation[] = [];

        for (const { report, call } of this.calls.get(`${type}:${id.toLowerCase()}`) ?? []) {
            if (call.sourceHash !== sourceHash) {
                this.issues.push(
                    Object.freeze({
                        code: CompatibilityIssueCode.ExecutionSourceMismatch,
                        severity: IssueSeverity.Warning,
                        message: `Execution '${report.id}' observed a different source hash for ${type} '${id}'; it is not evidence for the currently imported source.`,
                        source,
                    }),
                );
                continue;
            }

            observations.push(
                Object.freeze({
                    reportId: report.id,
                    executionId: call.executionId,
                    mode: call.mode,
                    status: call.status,
                    outcome: report.outcome,
                    executed: call.mode === ExecutionMode.Real && call.executed,
                    ...(call.sourceHash ? { sourceHash: call.sourceHash } : {}),
                }),
            );
        }

        return Object.freeze(observations);
    }
}
