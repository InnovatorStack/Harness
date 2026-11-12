import type { ExecutionInjection } from "../controls/failure-types.js";
import type { InjectionDetails } from "../controls/targets.js";
import type { RuntimeExecution, RuntimeObserver, TransactionOutcome } from "../core/types.js";
import type { SourceLocation } from "../diagnostics/source-location.js";
import { Item } from "../items/item.js";
import type { PlatformTraceEvent } from "../platform/trace.js";
import { describeFailure } from "./failures.js";
import { Snapshots } from "./snapshots.js";
import { ExecutionKind, ExecutionMode, ExecutionOutcome, ExecutionStatus } from "./types.js";
import type {
    ExecutionCall,
    ExecutionChange,
    ExecutionDefinition,
    ExecutionEvent,
    ExecutionLocation,
    ExecutionMock,
    ExecutionReport,
    ExecutionValue,
} from "./types.js";

interface RecorderLimits {
    readonly requests: number;
    readonly calls: number;
    readonly events: number;
    readonly bytes: number;
    readonly snapshotBytes: number;
    readonly depth: number;
}

const defaults: RecorderLimits = Object.freeze({
    requests: 100,
    calls: 2000,
    events: 5000,
    bytes: 1_048_576,
    snapshotBytes: 65_536,
    depth: 32,
});
const setupOperations = new Set([
    "packages.import",
    "packages.setup",
    "fixtures.load",
    "platform.seed",
    "platform.seedRecords",
]);

interface PendingCall {
    readonly execution: RuntimeExecution;
    readonly started: number;
    name: string;
    kind: ExecutionKind;
    mode: ExecutionMode;
    status: ExecutionStatus;
    durationMs: number;
    executed: boolean;
    input?: ExecutionValue;
    result?: ExecutionValue;
    source?: SourceLocation;
    sourceHash?: string;
    definition?: ExecutionDefinition;
    via?: ExecutionEvent;
    readonly events: ExecutionEvent[];
    error?: unknown;
}

interface PendingRequest {
    readonly id: string;
    readonly requestId: string;
    readonly startedAt: string;
    readonly started: number;
    readonly snapshots: Snapshots;
    readonly calls: Map<string, PendingCall>;
    readonly changes: Omit<ExecutionChange, "outcome">[];
    readonly mocks: ExecutionMock[];
    readonly failures: ExecutionInjection[];
    readonly bindings: Map<string, ExecutionEvent>;
    readonly omitted: {
        calls: number;
        changes: number;
        mocks: number;
        failures: number;
        events: number;
    };
    firstFailureId?: string;
    events: number;
}

/** Owns bounded, immutable reports. The dispatcher owns execution and transactions. */
export class ExecutionRecorder implements RuntimeObserver {
    private readonly active = new Map<string, PendingRequest>();
    private readonly reports: ExecutionReport[] = [];
    private readonly limits: RecorderLimits;

    constructor(
        limits: Partial<RecorderLimits> = {},
        private readonly now: () => Date = () => new Date(),
    ) {
        this.limits = { ...defaults, ...limits };
    }

    get executions(): readonly ExecutionReport[] {
        return Object.freeze([...this.reports]);
    }

    started(execution: RuntimeExecution, input: unknown): void {
        if (!execution.parentExecutionId) {
            if (setupOperations.has(execution.operation)) {
                return;
            }

            this.active.set(execution.requestId, {
                id: crypto.randomUUID(),
                requestId: execution.requestId,
                startedAt: this.now().toISOString(),
                started: performance.now(),
                snapshots: new Snapshots(this.limits),
                calls: new Map(),
                changes: [],
                mocks: [],
                failures: [],
                bindings: new Map(),
                omitted: { calls: 0, changes: 0, mocks: 0, failures: 0, events: 0 },
                events: 0,
            });
        }

        const request = this.active.get(execution.requestId);

        if (!request) {
            return;
        }

        if (request.calls.size >= this.limits.calls) {
            request.omitted.calls += 1;

            return;
        }

        const captured = request.snapshots.value(input);
        const via = execution.parentExecutionId
            ? request.bindings.get(execution.parentExecutionId)
            : undefined;

        if (execution.parentExecutionId && execution.operation === "platform.method") {
            request.bindings.delete(execution.parentExecutionId);
        }

        request.calls.set(execution.executionId, {
            execution,
            started: performance.now(),
            name: operationName(execution.operation, input),
            kind: operationKind(execution.operation),
            mode: ExecutionMode.Real,
            status: ExecutionStatus.Succeeded,
            durationMs: 0,
            executed: false,
            events: [],
            ...(captured === undefined ? {} : { input: captured }),
            ...(via && execution.operation === "platform.method" ? { via } : {}),
        });
    }

    completed(execution: RuntimeExecution, result: unknown): void {
        const request = this.active.get(execution.requestId);
        const call = request?.calls.get(execution.executionId);

        if (!request || !call) {
            return;
        }

        call.durationMs = performance.now() - call.started;
        const captured = request.snapshots.value(result);

        if (captured !== undefined) {
            call.result = captured;
        }
    }

    failed(execution: RuntimeExecution, error: unknown): void {
        const request = this.active.get(execution.requestId);
        const call = request?.calls.get(execution.executionId);

        if (!request) {
            return;
        }

        request.firstFailureId ??= execution.executionId;

        if (call) {
            call.durationMs = performance.now() - call.started;
            call.status = ExecutionStatus.Failed;
            call.error = error;
        }
    }

    record(event: PlatformTraceEvent): void {
        const request = this.active.get(event.requestId);

        if (!request) {
            return;
        }

        request.events += 1;

        if (request.events > this.limits.events) {
            if (event.kind === "mutation") {
                request.omitted.changes += 1;
            } else if (event.kind === "mock") {
                request.omitted.mocks += 1;
            } else {
                request.omitted.events += 1;
            }

            return;
        }

        const call = request.calls.get(event.executionId);

        if (call) {
            this.describeCall(call, event);

            if (event.result) {
                const captured = request.snapshots.value(event.result);

                if (captured !== undefined) {
                    call.result = captured;
                }
            }
        }

        this.recordBinding(request, call, event);
        this.recordChange(request, event);
        this.recordMock(request, event);
    }

    settled(requestId: string, transaction: TransactionOutcome, error?: unknown): void {
        const request = this.active.get(requestId);

        if (!request) {
            return;
        }

        this.active.delete(requestId);
        const outcome = transactionOutcome(transaction);
        const failureId = request.firstFailureId;
        const failureChain = this.chain(
            request,
            failureId && request.calls.has(failureId) ? failureId : requestId,
        );
        const failure =
            error === undefined
                ? undefined
                : describeFailure(error, failureChain, request.snapshots);
        const calls = this.finishCalls(request);
        const omitted = Object.freeze({ ...request.omitted, snapshots: request.snapshots.omitted });
        const report = Object.freeze({
            id: request.id,
            requestId,
            startedAt: request.startedAt,
            durationMs: performance.now() - request.started,
            outcome,
            calls,
            changes: Object.freeze(
                request.changes.map((change) => Object.freeze({ ...change, outcome })),
            ),
            mocks: Object.freeze([...request.mocks]),
            failures: Object.freeze([...request.failures]),
            ...(failure ? { error: failure } : {}),
            truncated: Object.values(omitted).some((count) => count > 0),
            omitted,
        });
        this.reports.push(report);

        if (this.reports.length > this.limits.requests) {
            this.reports.shift();
        }
    }

    injected(
        execution: RuntimeExecution,
        evidence: ExecutionInjection,
        target: InjectionDetails,
    ): void {
        const request = this.active.get(execution.requestId);

        if (!request) {
            return;
        }

        if (request.failures.length >= this.limits.calls) {
            request.omitted.failures += 1;

            return;
        }

        request.failures.push(evidence);
        const call = request.calls.get(execution.executionId);

        if (call) {
            call.name = target.name;

            if (target.kind === "sql") {
                call.kind = ExecutionKind.Sql;
            }

            if (target.source) {
                call.source = Object.freeze({ ...target.source });
            }

            if (target.definition) {
                call.definition = Object.freeze({ ...target.definition });
            }

            if (target.sourceHash) {
                call.sourceHash = target.sourceHash;
            }
        }
    }

    reset(): void {
        this.active.clear();
        this.reports.length = 0;
    }

    private recordBinding(
        request: PendingRequest,
        call: PendingCall | undefined,
        event: PlatformTraceEvent,
    ): void {
        if (event.kind === "event" || event.kind === "authorization") {
            const binding = Object.freeze({
                kind: event.kind,
                name: event.name,
                ...(event.source ? { source: Object.freeze({ ...event.source }) } : {}),
            });
            call?.events.push(binding);

            if (event.kind === "event") {
                request.bindings.set(event.executionId, binding);
            }
        }
    }

    private recordChange(request: PendingRequest, event: PlatformTraceEvent): void {
        if (event.kind === "mutation") {
            const before = event.before ? request.snapshots.record(event.before) : undefined;
            const after = event.after ? request.snapshots.record(event.after) : undefined;
            request.changes.push(
                Object.freeze({
                    executionId: event.executionId,
                    name: event.name,
                    ...(before ? { before } : {}),
                    ...(after ? { after } : {}),
                }),
            );
        }
    }

    private recordMock(request: PendingRequest, event: PlatformTraceEvent): void {
        if (event.kind === "mock" && event.mock) {
            const parameters = request.snapshots.record(event.mock.parameters);
            request.mocks.push(
                Object.freeze({
                    executionId: event.executionId,
                    name: event.name,
                    definition: event.mock.definition,
                    responseHash: event.mock.responseHash,
                    ...(parameters ? { parameters } : {}),
                    ...(event.mock.responseFile ? { responseFile: event.mock.responseFile } : {}),
                }),
            );
        }
    }

    private describeCall(call: PendingCall, event: PlatformTraceEvent): void {
        if (event.kind === "method" || event.kind === "execution") {
            call.kind = ExecutionKind.Method;
            call.name = event.name;
        } else if (event.kind === "action") {
            call.kind = event.name.startsWith("SQL Process:")
                ? ExecutionKind.Sql
                : ExecutionKind.Action;
            call.name = event.name;
        } else if (event.kind === "mock") {
            call.mode = ExecutionMode.Mocked;
            call.name = event.name;
        }

        if (["method", "execution", "action", "mock"].includes(event.kind)) {
            if (event.source) {
                call.source = Object.freeze({ ...event.source });
            }

            if (event.sourceHash) {
                call.sourceHash = event.sourceHash;
            }

            if (event.definition) {
                call.definition = Object.freeze({ ...event.definition });
                call.kind =
                    event.definition.type === "Method" ? ExecutionKind.Method : ExecutionKind.Sql;
            }
        }

        if (event.kind === "execution") {
            call.executed = true;
        }
    }

    private finishCalls(request: PendingRequest): readonly ExecutionCall[] {
        const children = new Map<string, ExecutionCall[]>();
        const roots: ExecutionCall[] = [];

        for (const call of [...request.calls.values()].reverse()) {
            const finished = this.finishCall(
                request,
                call,
                children.get(call.execution.executionId) ?? [],
            );
            const parentId = call.execution.parentExecutionId;

            if (parentId && request.calls.has(parentId)) {
                let siblings = children.get(parentId);

                if (!siblings) {
                    siblings = [];
                    children.set(parentId, siblings);
                }

                siblings.unshift(finished);
            } else {
                roots.unshift(finished);
            }
        }

        return Object.freeze(roots);
    }

    private finishCall(
        request: PendingRequest,
        call: PendingCall,
        children: readonly ExecutionCall[],
    ): ExecutionCall {
        const { execution, started: _started, error, ...details } = call;
        const finished: { -readonly [Key in keyof ExecutionCall]: ExecutionCall[Key] } = {
            ...details,
            executionId: execution.executionId,
            operation: execution.operation,
            events: Object.freeze([...call.events]),
            children: Object.freeze(children),
        };

        if (execution.parentExecutionId) {
            finished.parentExecutionId = execution.parentExecutionId;
        }

        if (error !== undefined) {
            finished.error = describeFailure(
                error,
                this.chain(request, execution.executionId),
                request.snapshots,
            );
        }

        return Object.freeze(finished);
    }

    private chain(request: PendingRequest, executionId: string): readonly ExecutionLocation[] {
        const result: ExecutionLocation[] = [];
        let call = request.calls.get(executionId);

        while (call) {
            result.unshift(
                Object.freeze({
                    executionId: call.execution.executionId,
                    name: call.name,
                    ...(call.source ? { source: call.source } : {}),
                }),
            );
            call = call.execution.parentExecutionId
                ? request.calls.get(call.execution.parentExecutionId)
                : undefined;
        }

        return Object.freeze(result);
    }
}

function operationKind(operation: string): ExecutionKind {
    if (operation === "platform.method") {
        return ExecutionKind.Method;
    }

    if (operation === "platform.apply") {
        return ExecutionKind.Action;
    }

    if (operation === "platform.aml") {
        return ExecutionKind.Aml;
    }

    if (operation === "platform.sql") {
        return ExecutionKind.Sql;
    }

    return ExecutionKind.Operation;
}

function operationName(operation: string, input: unknown): string {
    if (operation === "platform.apply" && input instanceof Item) {
        const node = input.payload.items[0];

        if (node) {
            return `${node.type}.${node.attributes.action ?? "get"}`;
        }
    }

    if (input !== null && typeof input === "object") {
        const key = operation === "platform.method" ? "name" : "method";
        const name: unknown = Object.getOwnPropertyDescriptor(input, key)?.value;

        if (typeof name === "string") {
            if (operation === "platform.method") {
                return name;
            }

            if (operation === "platform.sql") {
                return `SQL: ${name}`;
            }
        }
    }

    return operation;
}

function transactionOutcome(outcome: TransactionOutcome): ExecutionOutcome {
    if (outcome === "committed") {
        return ExecutionOutcome.Committed;
    }

    if (outcome === "rolledBack") {
        return ExecutionOutcome.RolledBack;
    }

    return ExecutionOutcome.Unknown;
}
