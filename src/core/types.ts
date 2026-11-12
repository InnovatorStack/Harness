import type { Operation } from "./operation.js";

export interface TransactionBoundary {
    begin(): void;
    commit(): void;
    rollback(): void;
}

/** Exceptions escaping a handler abort its owning request. Use results for recoverable outcomes. */
export interface ExecutionContext {
    readonly executionId: string;
    readonly requestId: string;
    readonly parentExecutionId?: string;
    executeSync<Input, Output>(operation: Operation<Input, Output>, input: Input): Output;
    execute<Input, Output>(operation: Operation<Input, Output>, input: Input): Promise<Output>;
    fail(error: unknown): never;
}

export type TransactionOutcome = "active" | "committed" | "rolledBack" | "unknown";

export type SyncHandler<Input, Output> = (input: Input, context: ExecutionContext) => Output;

export type AsyncHandler<Input, Output> = (
    input: Input,
    context: ExecutionContext,
) => Promise<Output>;

export interface ModuleRegistrar {
    handleSync<Input, Output>(
        operation: Operation<Input, Output>,
        handler: SyncHandler<Input, Output>,
    ): void;
    handleAsync<Input, Output>(
        operation: Operation<Input, Output>,
        handler: AsyncHandler<Input, Output>,
    ): void;
}

export interface HarnessModule {
    readonly id: string;
    readonly requires?: readonly string[];
    setup(registrar: ModuleRegistrar): void;
    reset?(): void;
    dispose?(): void;
}

export interface RuntimeOptions {
    readonly modules: readonly HarnessModule[];
    readonly transactions: TransactionBoundary;
    readonly observer?: RuntimeObserver;
}

/** Synchronous telemetry. It does not intercept handlers or own transaction decisions. */
export interface RuntimeExecution {
    readonly executionId: string;
    readonly requestId: string;
    readonly parentExecutionId?: string;
    readonly operation: string;
}

export interface RuntimeObserver {
    started(execution: RuntimeExecution, input: unknown): void;
    completed(execution: RuntimeExecution, result: unknown): void;
    failed(execution: RuntimeExecution, error: unknown): void;
    settled(requestId: string, outcome: TransactionOutcome, error?: unknown): void;
    reset(): void;
}

export interface TraceEvent {
    readonly sequence: number;
    readonly executionId: string;
    readonly parentExecutionId?: string;
    readonly operation: string;
    readonly phase: "start" | "success" | "failure";
    readonly error?: {
        readonly name: string;
        readonly message: string;
        readonly code?: string;
    };
}
