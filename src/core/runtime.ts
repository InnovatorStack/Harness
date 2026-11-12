import { WorkBudget } from "./budget.js";
import { registerContext } from "./context.js";
import { Deadline } from "./deadline.js";
import { RuntimeError } from "./errors.js";
import type { RuntimeErrorCode } from "./errors.js";
import {
    queuedRequestsMax,
    requestDepthMax,
    requestOperationsMax,
    requestTimeoutMs,
    traceEventsMax,
    workUnitsMax,
} from "./limits.js";
import { orderModules } from "./modules.js";
import { bindOperation, getOperationBinding } from "./operation.js";
import type { Operation, OperationBinding } from "./operation.js";
import type {
    ExecutionContext,
    HarnessModule,
    ModuleRegistrar,
    RuntimeOptions,
    RuntimeExecution,
    RuntimeObserver,
    TraceEvent,
    TransactionBoundary,
    TransactionOutcome,
} from "./types.js";

interface RequestState {
    active: boolean;
    rootId?: string;
    failure?: { readonly error: unknown };
    readonly children: Set<Promise<unknown>>;
    readonly frames: Map<string, ExecutionFrame>;
    readonly deadline: Deadline;
    readonly work: WorkBudget;
    settlementError?: unknown;
}

interface ExecutionFrame {
    readonly id: string;
    readonly parentId?: string;
    readonly operation: string;
    readonly mode: "sync" | "async";
    readonly depth: number;
    readonly children: Set<Promise<unknown>>;
    active: boolean;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
    return (
        ((typeof value === "object" && value !== null) || typeof value === "function") &&
        "then" in value &&
        typeof value.then === "function"
    );
}

function assertSynchronousFunction(
    callback: unknown,
    description: string,
    code: RuntimeErrorCode = "InvalidModule",
): void {
    if (typeof callback !== "function") {
        throw new RuntimeError(code, `${description} must be a function.`);
    }

    if (Object.prototype.toString.call(callback) === "[object AsyncFunction]") {
        throw new RuntimeError(code, `${description} must be synchronous.`);
    }
}

function errorDetails(error: unknown): NonNullable<TraceEvent["error"]> {
    if (error instanceof RuntimeError) {
        return Object.freeze({
            name: diagnosticText(error.name),
            message: diagnosticText(error.message),
            code: error.code,
        });
    }

    if (error instanceof Error) {
        return Object.freeze({
            name: diagnosticText(error.name),
            message: diagnosticText(error.message),
        });
    }

    return Object.freeze({ name: "Error", message: diagnosticText(String(error)) });
}

function diagnosticText(value: string): string {
    const diagnosticCharactersMax = 2048;

    return value.length <= diagnosticCharactersMax
        ? value
        : `${value.slice(0, diagnosticCharactersMax)} [truncated]`;
}

export class Runtime {
    private readonly transactions: TransactionBoundary;
    private readonly modules: readonly HarnessModule[];
    private readonly operationNames = new Map<string, object>();
    private readonly unbindOperations: (() => void)[] = [];
    private readonly events: TraceEvent[] = [];
    private readonly outcomes = new Map<string, TransactionOutcome>();
    private activeRequest: RequestState | undefined;
    private queue: Promise<void> = Promise.resolve();
    private queuedRequests = 0;
    private nextExecutionId = 0;
    private closed = false;
    private poisoned = false;
    private readonly observer: RuntimeObserver | undefined;

    constructor(options: RuntimeOptions) {
        this.observer = options.observer;

        if (this.observer) {
            for (const callback of [
                "started",
                "completed",
                "failed",
                "settled",
                "reset",
            ] as const) {
                assertSynchronousFunction(
                    this.observer[callback],
                    `Execution observer ${callback}`,
                );
            }
        }

        for (const step of ["begin", "commit", "rollback"] as const) {
            assertSynchronousFunction(
                options.transactions[step],
                `Transaction ${step}`,
                "InvalidTransactionBoundary",
            );
        }

        this.transactions = Object.freeze({
            begin: options.transactions.begin.bind(options.transactions),
            commit: options.transactions.commit.bind(options.transactions),
            rollback: options.transactions.rollback.bind(options.transactions),
        });
        this.modules = orderModules(options.modules);
        const initialized: HarnessModule[] = [];

        try {
            for (const module of this.modules) {
                initialized.push(module);
                this.setupModule(module);
            }
        } catch (error) {
            this.closed = true;
            const cleanupErrors = this.disposeModules(initialized);
            this.unbindAllOperations();

            if (cleanupErrors.length > 0) {
                throw new AggregateError(
                    [error, ...cleanupErrors],
                    "Module setup and cleanup failed.",
                    { cause: error },
                );
            }

            throw error;
        }
    }

    private setupModule(module: HarnessModule): void {
        let registering = true;
        const register = <Input, Output>(
            operation: Operation<Input, Output>,
            binding: OperationBinding<Input, Output>,
        ): void => {
            if (!registering) {
                throw new RuntimeError(
                    "InvalidModule",
                    `Module "${module.id}" cannot register handlers after setup.`,
                );
            }

            if (this.operationNames.has(operation.name)) {
                throw new RuntimeError(
                    "DuplicateOperation",
                    `Operation "${operation.name}" already has a handler.`,
                );
            }

            this.operationNames.set(operation.name, operation);
            this.unbindOperations.push(bindOperation(operation, this, binding));
        };

        const activeRegistrar: ModuleRegistrar = {
            handleSync: (operation, handler) => {
                assertSynchronousFunction(handler, `Handler for "${operation.name}"`);
                register(operation, { mode: "sync", handler });
            },

            handleAsync: (operation, handler) => register(operation, { mode: "async", handler }),
        };

        try {
            const setup = module.setup.bind(module);
            assertSynchronousFunction(setup, `Module "${module.id}" setup`);
            // oxlint-disable-next-line typescript/no-confusing-void-expression
            const result: unknown = setup(Object.freeze(activeRegistrar));

            if (isPromiseLike(result)) {
                void Promise.resolve(result).catch(() => {
                    // The synchronous contract violation is reported to the owning caller.
                });

                throw new RuntimeError(
                    "InvalidModule",
                    `Module "${module.id}" setup must be synchronous.`,
                );
            }
        } finally {
            registering = false;
        }
    }

    get trace(): readonly TraceEvent[] {
        return Object.freeze([...this.events]);
    }

    get isBusy(): boolean {
        return this.activeRequest !== undefined || this.queuedRequests > 0;
    }

    transactionOutcome(requestId: string): TransactionOutcome | undefined {
        return this.outcomes.get(requestId);
    }

    executeSync<Input, Output>(operation: Operation<Input, Output>, input: Input): Output {
        this.assertIdle();
        const request = this.beginRequest();

        try {
            const result = this.invokeSync(request, operation, input);

            return result;
        } catch (error) {
            request.active = false;

            return this.rollback(request, error);
        } finally {
            this.finishRequest(request);
        }
    }

    execute<Input, Output>(operation: Operation<Input, Output>, input: Input): Promise<Output> {
        try {
            this.assertOpen();

            if (this.queuedRequests >= queuedRequestsMax) {
                throw new RuntimeError("WorldBusy", "The request queue is full.");
            }
        } catch (error) {
            return Promise.reject(error);
        }

        this.queuedRequests += 1;
        const result = this.queue.then(() => this.executeQueued(operation, input));
        this.queue = result.then(
            () => {
                // Settle the queue independently of the caller-facing result.
            },
            () => {
                // Settle the queue independently of the caller-facing result.
            },
        );

        return result.finally(() => {
            this.queuedRequests -= 1;
        });
    }

    reset(): void {
        this.assertIdle();

        for (const module of [...this.modules].reverse()) {
            try {
                this.runLifecycleHook(module, "reset");
            } catch (error) {
                this.poisoned = true;

                throw error;
            }
        }

        this.events.length = 0;
        this.nextExecutionId = 0;
        this.outcomes.clear();
        this.observer?.reset();
    }

    close(): void {
        if (this.closed) {
            return;
        }

        if (this.isBusy) {
            throw new RuntimeError("WorldBusy", "The runtime has active or queued work.");
        }

        this.closed = true;
        const errors = this.disposeModules(this.modules);
        this.unbindAllOperations();

        if (errors.length > 0) {
            throw new AggregateError(errors, "Module cleanup failed.");
        }
    }

    private async executeQueued<Input, Output>(
        operation: Operation<Input, Output>,
        input: Input,
    ): Promise<Output> {
        const request = this.beginRequest();

        try {
            const result = await this.invokeAsync(request, operation, input);

            return result;
        } catch (error) {
            request.active = false;

            // Expired contexts fence late work. Detached Promises cannot delay rollback.
            return this.rollback(request, error);
        } finally {
            this.finishRequest(request);
        }
    }

    private beginRequest(): RequestState {
        this.assertOpen();

        try {
            this.runTransactionStep("begin");
        } catch (error) {
            this.poisoned = true;

            throw error;
        }

        const request: RequestState = {
            active: true,
            children: new Set(),
            frames: new Map(),
            deadline: new Deadline(
                requestTimeoutMs,
                () =>
                    new RuntimeError(
                        "UnfinishedExecution",
                        "The request exceeded its execution deadline.",
                    ),
            ),
            work: new WorkBudget(
                workUnitsMax,
                () => new RuntimeError("InvalidOperation", "The request exceeded its work limit."),
            ),
        };
        this.activeRequest = request;

        return request;
    }

    private invokeSync<Input, Output>(
        request: RequestState,
        operation: Operation<Input, Output>,
        input: Input,
        parentId?: string,
    ): Output {
        const frame = this.startFrame(request, operation.name, "sync", parentId);
        this.trackRequest(request, frame);
        const execution = this.executionInfo(request, frame);

        try {
            this.observer?.started(execution, input);
            this.assertHealthy(request);
            const binding = this.bindingFor(request, operation);

            if (binding.mode === "async") {
                throw this.invalidate(
                    request,
                    new RuntimeError(
                        "AsyncOperationInSyncExecution",
                        `Operation "${operation.name}" requires asynchronous execution.`,
                    ),
                );
            }

            const result = binding.handler(input, this.contextFor(request, frame));

            if (isPromiseLike(result)) {
                void Promise.resolve(result).catch(() => {
                    // The synchronous contract violation is reported to the owning caller.
                });

                throw this.invalidate(
                    request,
                    new RuntimeError(
                        "AsyncOperationInSyncExecution",
                        `Synchronous handler "${operation.name}" returned a Promise.`,
                    ),
                );
            }

            this.assertHealthy(request);
            this.observer?.completed(execution, result);
            this.assertHealthy(request);

            if (parentId === undefined) {
                this.commitRequest(request);
            }

            this.record(frame, "success");

            return result;
        } catch (error) {
            this.invalidate(request, error);
            this.record(frame, "failure", error);

            throw this.observeFailure(execution, error);
        } finally {
            frame.active = false;
        }
    }

    private async invokeAsync<Input, Output>(
        request: RequestState,
        operation: Operation<Input, Output>,
        input: Input,
        parentId?: string,
    ): Promise<Output> {
        const binding = getOperationBinding(operation, this);

        if (binding?.mode === "sync") {
            return this.invokeSync(request, operation, input, parentId);
        }

        const frame = this.startFrame(request, operation.name, "async", parentId);
        this.trackRequest(request, frame);
        const execution = this.executionInfo(request, frame);

        try {
            this.observer?.started(execution, input);
            this.assertHealthy(request);
            const asynchronousBinding = this.bindingFor(request, operation);

            if (asynchronousBinding.mode !== "async") {
                throw this.invalidate(
                    request,
                    new RuntimeError(
                        "InvalidOperation",
                        `Operation "${operation.name}" changed its execution mode.`,
                    ),
                );
            }

            const result = await request.deadline.wait(
                asynchronousBinding.handler(input, this.contextFor(request, frame)),
            );

            if (frame.children.size > 0) {
                throw this.invalidate(
                    request,
                    new RuntimeError(
                        "UnfinishedExecution",
                        `Operation "${operation.name}" returned before its nested asynchronous operations finished.`,
                    ),
                );
            }

            this.assertContext(request, frame);
            this.assertHealthy(request);
            this.observer?.completed(execution, result);
            this.assertHealthy(request);

            if (parentId === undefined) {
                this.commitRequest(request);
            }

            this.record(frame, "success");

            return result;
        } catch (error) {
            this.invalidate(request, error);
            this.record(frame, "failure", error);

            throw this.observeFailure(execution, error);
        } finally {
            frame.active = false;
        }
    }

    private bindingFor<Input, Output>(
        request: RequestState,
        operation: Operation<Input, Output>,
    ): OperationBinding<Input, Output> {
        const binding = getOperationBinding(operation, this);

        if (!binding || this.operationNames.get(operation.name) !== operation) {
            throw this.invalidate(
                request,
                new RuntimeError(
                    "UnknownOperation",
                    `Operation "${operation.name}" has no registered handler.`,
                ),
            );
        }

        return binding;
    }

    private contextFor(request: RequestState, frame: ExecutionFrame): ExecutionContext {
        const context: ExecutionContext = {
            executionId: frame.id,
            requestId: request.rootId ?? frame.id,

            fail: (error) => {
                this.assertContext(request, frame);

                throw this.invalidate(request, error);
            },

            ...(frame.parentId === undefined ? {} : { parentExecutionId: frame.parentId }),

            executeSync: (operation, input) => {
                this.assertContext(request, frame);

                return this.invokeSync(request, operation, input, frame.id);
            },

            execute: (operation, input) => {
                try {
                    this.assertContext(request, frame);

                    if (frame.mode === "sync") {
                        throw this.invalidate(
                            request,
                            new RuntimeError(
                                "AsyncOperationInSyncExecution",
                                `Synchronous operation "${frame.operation}" cannot start asynchronous work.`,
                            ),
                        );
                    }
                } catch (error) {
                    const rejected = Promise.reject(error);
                    void rejected.catch(() => {
                        // Failure already poisons the request if the caller drops this Promise.
                    });

                    return rejected;
                }

                const child = this.invokeAsync(request, operation, input, frame.id);
                frame.children.add(child);
                request.children.add(child);
                void child.then(
                    () => {
                        frame.children.delete(child);
                        request.children.delete(child);
                    },
                    () => {
                        frame.children.delete(child);
                        request.children.delete(child);
                    },
                );

                return child;
            },
        };
        registerContext(
            context,
            () => this.assertContext(request, frame),
            (units) => this.spendWork(request, units),
        );

        return Object.freeze(context);
    }

    private spendWork(request: RequestState, units: number): void {
        try {
            request.work.spend(units);
        } catch (error) {
            throw this.invalidate(request, error);
        }
    }

    private assertContext(request: RequestState, frame: ExecutionFrame): void {
        if (!request.active || !frame.active || this.activeRequest !== request) {
            const error = new RuntimeError(
                "ExpiredExecutionContext",
                `Execution context "${frame.id}" is no longer active.`,
            );

            if (request.active && this.activeRequest === request) {
                this.invalidate(request, error);
            }

            throw error;
        }

        this.assertHealthy(request);
    }

    private assertHealthy(request: RequestState): void {
        if (request.failure) {
            throw request.failure.error;
        }
    }

    private commitRequest(request: RequestState): void {
        request.active = false;
        this.runTransactionStep("commit");

        if (request.rootId) {
            this.outcomes.set(request.rootId, "committed");
        }
    }

    private trackRequest(request: RequestState, frame: ExecutionFrame): void {
        if (!request.rootId) {
            request.rootId = frame.id;
            this.outcomes.set(frame.id, "active");
        }
    }

    private executionInfo(request: RequestState, frame: ExecutionFrame): RuntimeExecution {
        return Object.freeze({
            executionId: frame.id,
            requestId: request.rootId ?? frame.id,
            operation: frame.operation,
            ...(frame.parentId ? { parentExecutionId: frame.parentId } : {}),
        });
    }

    private settleObservation(request: RequestState): void {
        if (request.rootId) {
            this.observer?.settled(
                request.rootId,
                this.outcomes.get(request.rootId) ?? "unknown",
                request.settlementError ?? request.failure?.error,
            );
        }
    }

    private finishRequest(request: RequestState): void {
        request.active = false;
        request.deadline.cancel(
            request.failure?.error ??
                new RuntimeError("ExpiredExecutionContext", "The owning request has finished."),
        );
        request.deadline[Symbol.dispose]();

        for (const frame of request.frames.values()) {
            frame.active = false;
        }

        try {
            this.settleObservation(request);
        } catch (error) {
            if (request.failure) {
                throw new AggregateError(
                    [request.settlementError ?? request.failure.error, error],
                    "Execution and settlement observation failed.",
                    { cause: error },
                );
            }

            throw error;
        } finally {
            this.activeRequest = undefined;
        }
    }

    private observeFailure(execution: RuntimeExecution, error: unknown): unknown {
        try {
            this.observer?.failed(execution, error);

            return error;
        } catch (observerError) {
            return new AggregateError(
                [error, observerError],
                "Execution and failure observation failed.",
            );
        }
    }

    private invalidate<Failure>(request: RequestState, error: Failure): Failure {
        request.failure ??= { error };

        return error;
    }

    private startFrame(
        request: RequestState,
        operation: string,
        mode: "sync" | "async",
        parentId?: string,
    ): ExecutionFrame {
        const parent = parentId === undefined ? undefined : request.frames.get(parentId);
        const depth = (parent?.depth ?? 0) + 1;

        if (depth > requestDepthMax || request.frames.size >= requestOperationsMax) {
            throw this.invalidate(
                request,
                new RuntimeError(
                    "InvalidOperation",
                    "The request exceeded its nesting or operation limit.",
                ),
            );
        }

        if (this.events.length >= traceEventsMax - requestOperationsMax * 2) {
            throw this.invalidate(
                request,
                new RuntimeError(
                    "InvalidOperation",
                    "The runtime trace is full. Reset the world before further execution.",
                ),
            );
        }

        const frame: ExecutionFrame = {
            id: String(++this.nextExecutionId),
            operation,
            mode,
            depth,
            active: true,
            children: new Set(),
            ...(parentId === undefined ? {} : { parentId }),
        };
        request.frames.set(frame.id, frame);
        this.record(frame, "start");

        return frame;
    }

    private record(frame: ExecutionFrame, phase: TraceEvent["phase"], error?: unknown): void {
        this.events.push(
            Object.freeze({
                sequence: this.events.length + 1,
                executionId: frame.id,
                operation: frame.operation,
                phase,
                ...(frame.parentId === undefined ? {} : { parentExecutionId: frame.parentId }),
                ...(phase === "failure" ? { error: errorDetails(error) } : {}),
            }),
        );
    }

    private rollback(request: RequestState, error: unknown): never {
        request.settlementError = error;

        try {
            this.runTransactionStep("rollback");

            if (request.rootId) {
                this.outcomes.set(request.rootId, "rolledBack");
            }
        } catch (rollbackError) {
            this.poisoned = true;

            if (request.rootId) {
                this.outcomes.set(request.rootId, "unknown");
            }

            const failure = new AggregateError(
                [error, rollbackError],
                "Execution and transaction rollback failed.",
            );
            request.settlementError = failure;

            throw failure;
        }

        throw error;
    }

    private assertOpen(): void {
        if (this.closed || this.poisoned) {
            throw new RuntimeError("RuntimeClosed", "The runtime is closed.");
        }
    }

    private runTransactionStep(step: "begin" | "commit" | "rollback"): void {
        // oxlint-disable-next-line typescript/no-confusing-void-expression
        const result: unknown = this.transactions[step]();

        if (isPromiseLike(result)) {
            void Promise.resolve(result).catch(() => {
                // The synchronous contract violation is reported to the owning caller.
            });

            throw new RuntimeError(
                "InvalidTransactionBoundary",
                `Transaction ${step} returned a Promise; transaction callbacks must be synchronous.`,
            );
        }
    }

    private assertIdle(): void {
        this.assertOpen();

        if (this.isBusy) {
            throw new RuntimeError("WorldBusy", "The runtime has active or queued work.");
        }
    }

    private disposeModules(modules: readonly HarnessModule[]): unknown[] {
        const errors: unknown[] = [];

        for (const module of [...modules].reverse()) {
            try {
                this.runLifecycleHook(module, "dispose");
            } catch (error) {
                errors.push(error);
            }
        }

        return errors;
    }

    private runLifecycleHook(module: HarnessModule, hookName: "reset" | "dispose"): void {
        const hook = module[hookName];

        if (!hook) {
            return;
        }

        assertSynchronousFunction(hook, `Module "${module.id}" ${hookName}`);
        // oxlint-disable-next-line typescript/no-confusing-void-expression
        const result: unknown = hook.call(module);

        if (isPromiseLike(result)) {
            void Promise.resolve(result).catch(() => {
                // The synchronous contract violation is reported to the owning caller.
            });

            throw new RuntimeError(
                "InvalidModule",
                `Module "${module.id}" ${hookName} must be synchronous.`,
            );
        }
    }

    private unbindAllOperations(): void {
        for (const unbind of this.unbindOperations) {
            unbind();
        }

        this.unbindOperations.length = 0;
        this.operationNames.clear();
    }
}

export function createRuntime(options: RuntimeOptions): Runtime {
    return new Runtime(options);
}
