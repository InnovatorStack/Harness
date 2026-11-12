import { PlatformError } from "../../platform/errors.js";
import { encodeMessage, pendingCallsMax, readMessages } from "./protocol.js";

export type ManagedProcess = Bun.Subprocess<"pipe", "pipe", "inherit">;

const contextsPerWorkerMax = 32;
const workers = new Set<ManagedWorker>();

export interface WorkerReceiver {
    message(value: Record<string, unknown>): void;
    failed(error: unknown): void;
}

/** Own the process transport independently of a world's collectible managed context. */
export class ManagedWorker {
    readonly process: ManagedProcess;
    private receiver: WorkerReceiver | undefined;
    private stopped = false;
    private contexts = 0;
    private readonly invocations = new Set<string>();
    private resumeReading: ((active: boolean) => void) | undefined;
    reusable = true;
    private resetPending:
        | { resolve(): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> }
        | undefined;
    ready: Promise<void> = Promise.resolve();

    constructor(dotnet: string, host: string, references: readonly string[]) {
        this.process = Bun.spawn([dotnet, host, ...references], {
            stdin: "pipe",
            stdout: "pipe",
            stderr: "inherit",
        });
        workers.add(this);
        void this.observe();
    }

    attach(receiver: WorkerReceiver): void {
        if (this.stopped || this.receiver) {
            throw new PlatformError(
                "WorkerUnavailable",
                "The C# worker cannot accept another owner.",
            );
        }

        this.receiver = receiver;
        this.process.ref();
        this.process.stdin.ref();
    }

    get available(): boolean {
        return !this.stopped && this.process.exitCode === null;
    }

    expectInvocation(id: string): void {
        if (this.stopped || this.invocations.has(id) || this.invocations.size >= pendingCallsMax) {
            throw new PlatformError(
                "ProtocolLimit",
                "The C# invocation queue is unavailable or full.",
            );
        }

        this.invocations.add(id);
        this.wakeReader(true);
    }

    release(): void {
        this.receiver = undefined;
        this.contexts += 1;

        if (
            this.contexts >= contextsPerWorkerMax ||
            this.resetPending ||
            this.invocations.size > 0
        ) {
            this.close();

            return;
        }

        this.ready = new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
                () =>
                    this.close(
                        new PlatformError("WorkerUnavailable", "C# context reset timed out."),
                    ),
                1000,
            );
            timer.unref();
            this.resetPending = { resolve, reject, timer };
        });
        void this.ready.catch(() => {
            /* Acquisition observes reset failures before reuse. */
        });
        this.wakeReader(true);
        void this.resetContext();
        this.process.unref();
        this.process.stdin.unref();
    }

    private async resetContext(): Promise<void> {
        try {
            await this.process.stdin.write(encodeMessage({ kind: "reset", id: "reset" }));
            await this.process.stdin.flush();
        } catch (error) {
            this.close(error);
        }
    }

    close(error: unknown = new PlatformError("WorkerExited", "The C# worker closed.")): void {
        if (this.stopped) {
            return;
        }

        this.stopped = true;
        workers.delete(this);
        this.invocations.clear();
        this.wakeReader(false);
        this.process.kill("SIGKILL");
        const reset = this.resetPending;
        this.resetPending = undefined;

        if (reset) {
            clearTimeout(reset.timer);
            reset.reject(error);
        }

        const receiver = this.receiver;
        this.receiver = undefined;
        receiver?.failed(error);
    }

    private receive(message: Record<string, unknown>): void {
        if (message.reusable === false) {
            this.reusable = false;
        }

        if (message.kind === "result" || message.kind === "failure") {
            this.invocations.delete(String(message.id));
        }

        if (message.kind === "reset" && this.resetPending) {
            const reset = this.resetPending;
            this.resetPending = undefined;
            clearTimeout(reset.timer);
            reset.resolve();
        } else if (this.receiver) {
            this.receiver.message(message);
        } else {
            this.close(
                new PlatformError("InvalidProtocol", "An idle C# worker emitted a request."),
            );
        }
    }

    private readWhenActive(): Promise<boolean> {
        // Keep an owned pipe armed between calls. Reset acknowledgement ends the active world.
        if (this.stopped || this.receiver || this.resetPending || this.invocations.size > 0) {
            return Promise.resolve(!this.stopped);
        }

        return new Promise<boolean>((resolve) => {
            this.resumeReading = resolve;
        });
    }

    private wakeReader(active: boolean): void {
        const resume = this.resumeReading;
        this.resumeReading = undefined;
        resume?.(active);
    }

    private async observe(): Promise<void> {
        try {
            await Promise.all([
                readMessages(
                    this.process.stdout,
                    (message) => this.receive(message),
                    () => this.readWhenActive(),
                ),
                this.process.exited.then((exit) =>
                    this.close(new PlatformError("WorkerExited", `C# worker exited (${exit}).`)),
                ),
            ]);
        } catch (error) {
            this.close(error);
        }
    }
}

let idle: { readonly key: string; readonly worker: ManagedWorker } | undefined;

process.once("beforeExit", () => {
    idle?.worker.close();
    idle = undefined;
});

process.once("exit", () => {
    for (const worker of workers) {
        worker.close();
    }
});

export function acquireWorker(
    dotnet: string,
    host: string,
    references: readonly string[],
): ManagedWorker {
    const key = JSON.stringify([dotnet, host, references]);

    if (idle?.key === key && idle.worker.available) {
        const worker = idle.worker;
        idle = undefined;

        return worker;
    }

    return new ManagedWorker(dotnet, host, references);
}

export function releaseWorker(key: string, worker: ManagedWorker): void {
    idle?.worker.close();
    worker.release();
    idle = { key, worker };
}
