import { requestOperationsMax } from "../../core/limits.js";
import { Item } from "../../items/item.js";
import { ApplicationError, PlatformError } from "../../platform/errors.js";
import type { MethodDefinition, MethodExecutor, MethodPorts } from "../types.js";
import { managedCallback, requestChange } from "./callbacks.js";
import type { ManagedCallbackState } from "./callbacks.js";
import { CSharpCompiler } from "./compiler.js";
import type { CompiledMethod, CSharpOptions } from "./compiler.js";
import { ManagedOrigins } from "./origins.js";
import { encodeMessage, pendingCallsMax, messageBytesMax } from "./protocol.js";
import { ManagedSecurity } from "./security.js";
import { acquireWorker, releaseWorker } from "./worker.js";
import type { ManagedProcess, ManagedWorker } from "./worker.js";

const assembliesMax = 2048;

interface PendingInvocation {
    failure?: { readonly error: unknown };
    received: boolean;
    started: boolean;
    readonly security: ManagedSecurity;
    readonly origins: ManagedOrigins;
    callbackCount: number;
    readonly context: Item;
    readonly ports: MethodPorts;
    readonly resolve: (item: Item) => void;
    readonly reject: (error: unknown) => void;
    readonly timer: ReturnType<typeof setTimeout>;
}

export class CSharpExecutor implements MethodExecutor {
    readonly language = "C#";
    private readonly compiler: CSharpCompiler;
    private worker: ManagedProcess | undefined;
    private transport: ManagedWorker | undefined;
    private workerKey = "";
    private readonly loadedAssemblies = new Set<string>();
    private readonly callbacks = new Set<string>();
    private queuedBytes = 0;
    private writes: Promise<void> = Promise.resolve();
    private readonly pending = new Map<string, PendingInvocation>();
    private nextId = 0;
    private generation = 0;
    private starting: Promise<void> | undefined;

    constructor(options: CSharpOptions = {}) {
        this.compiler = new CSharpCompiler(options);
    }

    async execute(method: MethodDefinition, context: Item, ports: MethodPorts): Promise<Item> {
        const generation = this.generation;
        const host = await this.compiler.host();
        await this.start(host);
        const compiled = await this.compiler.method(
            method,
            host,
            ports.eventData?.kind ?? ports.serverEvent?.name,
        );

        if (generation !== this.generation) {
            throw new PlatformError("ExecutorReset", "C# executor was reset during compilation.");
        }

        if (this.pending.size >= pendingCallsMax || this.nextId >= Number.MAX_SAFE_INTEGER) {
            throw new PlatformError("ProtocolLimit", "The C# invocation limit was reached.");
        }

        if (
            !this.loadedAssemblies.has(compiled.assembly) &&
            this.loadedAssemblies.size >= assembliesMax
        ) {
            throw new PlatformError(
                "ProtocolLimit",
                "Reset the world before loading more C# Methods.",
            );
        }

        this.loadedAssemblies.add(compiled.assembly);
        const id = String(++this.nextId);
        const origins = new ManagedOrigins();

        return await new Promise<Item>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.timeout(id, method.name);
            }, this.compiler.timeoutMs);
            this.pending.set(id, {
                context,
                ports,
                resolve: deferNativeCompletion(resolve),
                reject: deferNativeCompletion(reject),
                timer,
                received: false,
                started: false,
                callbackCount: 0,
                security: new ManagedSecurity(),
                origins,
            });

            try {
                this.invoke(id, compiled, context, ports, origins);
            } catch (error) {
                this.stop(error);
            }
        });
    }

    private timeout(id: string, method: string): void {
        const invocation = this.pending.get(id);
        let phase = "worker receipt";

        if (invocation?.received) {
            phase = "Method loading";
        }

        if (invocation?.started) {
            phase = "source execution";
        }

        this.stop(
            new PlatformError(
                "MethodTimeout",
                `Method '${method}' exceeded ${this.compiler.timeoutMs}ms during ${phase}.`,
                {
                    cause: new Error(
                        JSON.stringify({
                            received: invocation?.received ?? false,
                            sourceStarted: invocation?.started ?? false,
                            callbacks: invocation?.callbackCount ?? 0,
                            pendingCallbacks: this.callbacks.size,
                            queuedBytes: this.queuedBytes,
                            workerExitCode: this.worker?.exitCode ?? null,
                        }),
                    ),
                },
            ),
        );
    }

    reset(): void {
        this.stop(new PlatformError("ExecutorReset", "C# executor was reset."), true);
    }

    dispose(): void {
        this.stop(new PlatformError("ExecutorClosed", "C# executor was closed."), true);
    }

    private async start(host: string): Promise<void> {
        if (this.worker) {
            return;
        }

        const starting = this.starting ?? this.connect(host);
        this.starting = starting;

        try {
            await starting;
        } finally {
            if (this.starting === starting) {
                this.starting = undefined;
            }
        }
    }

    private async connect(host: string): Promise<void> {
        const generation = this.generation;
        const transport = await acquireWorker(this.compiler.dotnet, host, this.compiler.references);

        if (generation !== this.generation) {
            transport.close();

            throw new PlatformError(
                "ExecutorReset",
                "C# executor was reset during worker acquisition.",
            );
        }

        const worker = transport.process;
        this.transport = transport;
        this.workerKey = JSON.stringify([this.compiler.dotnet, host, this.compiler.references]);
        this.worker = worker;
        this.writes = Promise.resolve();
        transport.attach({
            message: (message) => {
                if (this.worker === worker) {
                    this.receive(message, worker);
                }
            },

            failed: (error) => {
                if (this.worker === worker) {
                    this.stop(error);
                }
            },
        });
    }

    private invoke(
        id: string,
        compiled: CompiledMethod,
        context: Item,
        ports: MethodPorts,
        origins: ManagedOrigins,
    ): void {
        if (!this.transport) {
            throw new PlatformError(
                "WorkerUnavailable",
                "The C# worker has no invocation transport.",
            );
        }

        this.transport.expectInvocation(id);
        this.send({
            kind: "invoke",
            id,
            ...compiled,
            context: context.payload,
            contextOrigins: origins.capture(context.payload),
            ...(ports.eventData ? { eventData: ports.eventData } : {}),
        });
    }

    private send(message: unknown): void {
        const worker = this.worker;

        if (!worker) {
            throw new PlatformError("WorkerUnavailable", "The C# worker is not running.");
        }

        const bytes = encodeMessage(message);

        if (this.queuedBytes + bytes.length > messageBytesMax * 2) {
            throw new PlatformError("ProtocolLimit", "The C# outgoing queue is full.");
        }

        this.queuedBytes += bytes.length;
        this.writes = this.writes
            .then(async () => {
                if (this.worker !== worker) {
                    return;
                }

                try {
                    await worker.stdin.write(bytes);
                    await worker.stdin.flush();
                } finally {
                    if (this.worker === worker) {
                        this.queuedBytes -= bytes.length;
                    }
                }
            })
            .catch((error: unknown) => {
                if (this.worker === worker) {
                    this.stop(error);
                }
            });
    }

    private receive(message: Record<string, unknown>, worker: ManagedProcess): void {
        if (message.kind === "received") {
            const pending =
                typeof message.id === "string" ? this.pending.get(message.id) : undefined;

            if (!pending || pending.received) {
                throw new PlatformError(
                    "InvalidProtocol",
                    "Unknown or duplicate C# invocation receipt.",
                );
            }

            pending.received = true;
        } else if (message.kind === "started") {
            const pending =
                typeof message.id === "string" ? this.pending.get(message.id) : undefined;

            if (!pending || pending.started) {
                throw new PlatformError(
                    "InvalidProtocol",
                    "Unknown or duplicate C# invocation start.",
                );
            }

            pending.started = true;
            pending.ports.executionStarted?.();
        } else if (message.kind === "callback") {
            void this.callback(message, worker).catch((error: unknown) => {
                if (this.worker === worker) {
                    this.stop(error);
                }
            });
        } else {
            this.complete(message);
        }
    }

    private complete(message: Record<string, unknown>): void {
        const id = message.id;

        if (typeof id !== "string") {
            throw new PlatformError("InvalidProtocol", "Missing invocation ID.");
        }

        const pending = this.pending.get(id);

        if (!pending) {
            throw new PlatformError("InvalidProtocol", `Unknown C# invocation '${id}'.`);
        }

        if (message.kind !== "failure" && message.kind !== "result") {
            throw new PlatformError("InvalidProtocol", "Unknown C# result kind.");
        }

        try {
            pending.security[Symbol.dispose]();
        } catch (error) {
            pending.failure ??= { error };
        }

        this.pending.delete(id);
        clearTimeout(pending.timer);

        try {
            synchronizeContext(pending.context, message, pending.origins);

            if (pending.failure !== undefined) {
                throw pending.failure.error;
            }

            if (message.kind === "failure") {
                throw managedFailure(message);
            }

            pending.resolve(new Item(pending.origins.decode(message.payload, message.origins)));
        } catch (error) {
            if (pending.failure !== undefined && pending.failure.error !== error) {
                pending.reject(
                    new AggregateError(
                        [pending.failure.error, error],
                        "Managed execution failed and its input could not be synchronized.",
                    ),
                );
            } else {
                pending.reject(error);
            }
        }
    }

    private async callback(
        message: Record<string, unknown>,
        worker: ManagedProcess,
    ): Promise<void> {
        const id = message.id;
        const invocationId = message.invocationId;

        if (typeof id !== "string" || typeof invocationId !== "string") {
            throw new PlatformError("InvalidProtocol", "Missing callback identity.");
        }

        const pending = this.pending.get(invocationId);

        if (!pending) {
            throw new PlatformError(
                "ExpiredCallback",
                "C# callback refers to an expired invocation.",
            );
        }

        pending.callbackCount += 1;

        if (
            !pending.started ||
            pending.callbackCount > requestOperationsMax ||
            this.callbacks.has(id) ||
            this.callbacks.size >= pendingCallsMax
        ) {
            throw new PlatformError("ProtocolLimit", "The C# callback limit was reached.");
        }

        this.callbacks.add(id);
        const state: ManagedCallbackState = { origins: pending.origins };

        try {
            const result = await managedCallback(message, pending.ports, pending.security, state);

            if (this.worker === worker) {
                this.send({
                    kind: "callbackResult",
                    id,
                    payload: result.payload,
                    requestChange: requestChange(state),
                });
            }
        } catch (error) {
            if (this.worker !== worker) {
                return;
            }

            this.failCallback(error, pending, id, state);
        } finally {
            if (this.worker === worker) {
                this.callbacks.delete(id);
            }
        }
    }

    private failCallback(
        error: unknown,
        pending: PendingInvocation,
        id: string,
        state: ManagedCallbackState,
    ): void {
        const response = { kind: "callbackResult", id, requestChange: requestChange(state) };

        if (error instanceof ApplicationError) {
            this.send({ ...response, payload: error.item.payload });

            return;
        }

        pending.failure = { error };
        const message = error instanceof Error ? error.message : String(error);

        try {
            pending.ports.fail(message);
        } catch (failure) {
            // fail() poisons the owning transaction and is required to throw.
            pending.failure = { error: failure };
        }

        this.send({ ...response, error: message });
    }

    private stop(error: unknown, reuse = false): void {
        this.generation += 1;
        this.starting = undefined;
        const transport = this.transport;
        this.worker = undefined;
        this.transport = undefined;

        if (transport) {
            this.releaseTransport(transport, error, reuse);
        }

        this.loadedAssemblies.clear();
        this.callbacks.clear();
        this.queuedBytes = 0;

        for (const invocation of this.pending.values()) {
            clearTimeout(invocation.timer);

            try {
                invocation.security[Symbol.dispose]();
                invocation.reject(error);
            } catch (cleanup) {
                invocation.reject(
                    new AggregateError(
                        [error, cleanup],
                        "Managed execution and grant cleanup failed.",
                    ),
                );
            }
        }

        this.pending.clear();
    }

    private releaseTransport(transport: ManagedWorker, error: unknown, reuse: boolean): void {
        if (
            !reuse ||
            !transport.available ||
            !transport.reusable ||
            this.compiler.references.length > 0
        ) {
            transport.close(error);

            return;
        }

        if (this.pending.size === 0 && this.callbacks.size === 0 && this.queuedBytes === 0) {
            releaseWorker(this.workerKey, transport);
        } else {
            transport.close(error);
        }
    }
}

export function csharp(options: CSharpOptions = {}): MethodExecutor {
    return new CSharpExecutor(options);
}

function synchronizeContext(
    context: Item,
    message: Record<string, unknown>,
    origins: ManagedOrigins,
): void {
    if (message.contextError !== undefined) {
        throw managedFailure(message);
    }

    const input = message.contextIsResult === true ? message.payload : message.context;

    if (input === undefined && message.kind === "failure") {
        return;
    }

    const frame = message.contextIsResult === true ? message.origins : message.contextOrigins;
    const changed = origins.decode(input, frame);
    context.payload.items = changed.items;

    if (changed.error === undefined) {
        delete context.payload.error;
    } else {
        context.payload.error = changed.error;
    }

    if (changed.result === undefined) {
        delete context.payload.result;
    } else {
        context.payload.result = changed.result;
    }

    if (changed.messages === undefined) {
        delete context.payload.messages;
    } else {
        context.payload.messages = changed.messages;
    }
}

function managedFailure(message: Record<string, unknown>): PlatformError {
    let error =
        typeof message.error === "string" ? message.error : "Invalid managed failure response.";

    if (typeof message.contextError === "string") {
        error += `\nFailed to synchronize Method input: ${message.contextError}`;
    }

    return new PlatformError("MethodExecutionFailed", error);
}

/** Settle outside the Windows pipe callback so Bun's native matchers can reenter its loop. */
function deferNativeCompletion<Value>(complete: (value: Value) => void): (value: Value) => void {
    if (process.platform !== "win32") {
        return complete;
    }

    return (value) => {
        setTimeout(() => {
            complete(value);
        }, 0);
    };
}
