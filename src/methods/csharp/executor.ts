import { requestOperationsMax } from "../../core/limits.js";
import { decodePayload } from "../../items/codec.js";
import { Item } from "../../items/item.js";
import { ApplicationError, PlatformError } from "../../platform/errors.js";
import type { MethodDefinition, MethodExecutor, MethodPorts } from "../types.js";
import { managedCallback } from "./callbacks.js";
import { CSharpCompiler } from "./compiler.js";
import type { CompiledMethod, CSharpOptions } from "./compiler.js";
import { encodeMessage, pendingCallsMax, messageBytesMax } from "./protocol.js";
import { ManagedSecurity } from "./security.js";
import { acquireWorker, releaseWorker } from "./worker.js";
import type { ManagedProcess, ManagedWorker } from "./worker.js";

const assembliesMax = 2048;

interface PendingInvocation {
    failure?: { readonly error: unknown };
    started: boolean;
    readonly security: ManagedSecurity;
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

    constructor(options: CSharpOptions = {}) {
        this.compiler = new CSharpCompiler(options);
    }

    async execute(method: MethodDefinition, context: Item, ports: MethodPorts): Promise<Item> {
        const generation = this.generation;
        const host = await this.compiler.host();
        await this.start(host);
        const compiled = await this.compiler.method(method, host, ports.serverEvent?.name);

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

        return await new Promise<Item>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.timeout(id, method.name);
            }, this.compiler.timeoutMs);
            this.pending.set(id, {
                context,
                ports,
                resolve,
                reject,
                timer,
                started: false,
                callbackCount: 0,
                security: new ManagedSecurity(),
            });

            try {
                this.invoke(id, compiled, context);
            } catch (error) {
                this.stop(error);
            }
        });
    }

    private timeout(id: string, method: string): void {
        const invocation = this.pending.get(id);
        this.stop(
            new PlatformError(
                "MethodTimeout",
                `Method '${method}' exceeded ${this.compiler.timeoutMs}ms.`,
                {
                    cause: {
                        sourceStarted: invocation?.started ?? false,
                        callbacks: invocation?.callbackCount ?? 0,
                        pendingCallbacks: this.callbacks.size,
                        queuedBytes: this.queuedBytes,
                        workerExitCode: this.worker?.exitCode ?? null,
                    },
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

        const transport = acquireWorker(this.compiler.dotnet, host, this.compiler.references);
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
        await transport.ready;
    }

    private invoke(id: string, compiled: CompiledMethod, context: Item): void {
        if (!this.transport) {
            throw new PlatformError(
                "WorkerUnavailable",
                "The C# worker has no invocation transport.",
            );
        }

        this.transport.expectInvocation(id);
        this.send({ kind: "invoke", id, ...compiled, context: context.payload });
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
        if (message.kind === "started") {
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
            pending.failure = { error };
        }

        this.pending.delete(id);
        clearTimeout(pending.timer);

        if (pending.failure !== undefined) {
            pending.reject(pending.failure.error);

            return;
        }

        if (message.kind === "failure") {
            pending.reject(
                new PlatformError(
                    "MethodExecutionFailed",
                    typeof message.error === "string"
                        ? message.error
                        : "Invalid managed failure response.",
                ),
            );
        } else if (message.kind === "result") {
            try {
                const mutated = decodePayload(
                    message.contextIsResult === true ? message.payload : message.context,
                );
                const result = new Item(decodePayload(message.payload));
                pending.context.payload.items = mutated.items;

                if (mutated.error) {
                    pending.context.payload.error = mutated.error;
                } else {
                    delete pending.context.payload.error;
                }

                if (mutated.result === undefined) {
                    delete pending.context.payload.result;
                } else {
                    pending.context.payload.result = mutated.result;
                }

                pending.resolve(result);
            } catch (error) {
                pending.reject(error);
            }
        } else {
            pending.reject(new PlatformError("InvalidProtocol", "Unknown C# result kind."));
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

        try {
            const result = await managedCallback(message, pending.ports, pending.security);

            if (this.worker === worker) {
                this.send({ kind: "callbackResult", id, payload: result.payload });
            }
        } catch (error) {
            if (this.worker !== worker) {
                return;
            }

            if (error instanceof ApplicationError) {
                this.send({ kind: "callbackResult", id, payload: error.item.payload });
            } else {
                pending.failure = { error };
                const message = error instanceof Error ? error.message : String(error);

                try {
                    pending.ports.fail(message);
                } catch (failure) {
                    // fail() poisons the owning transaction and is required to throw.
                    pending.failure = { error: failure };
                }

                this.send({ kind: "callbackResult", id, error: message });
            }
        } finally {
            if (this.worker === worker) {
                this.callbacks.delete(id);
            }
        }
    }

    private stop(error: unknown, reuse = false): void {
        this.generation += 1;
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
