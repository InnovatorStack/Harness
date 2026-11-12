import type { ExecutionOutcome, ExecutionReport } from "../instrumentation/types.js";

export type ExecutionObserver = (execution: ExecutionReport) => void;

export interface Observation extends Disposable {}

const observersMax = 128;

export class ObserverError extends AggregateError {
    override readonly name = "ObserverError";

    constructor(
        errors: readonly unknown[],
        readonly requestId: string,
        readonly outcome: ExecutionOutcome,
    ) {
        super(
            errors,
            `Execution observers failed after request '${requestId}' settled (${outcome}).`,
        );
    }
}

/** Callbacks observe settled reports; their failures never change the business transaction. */
export class ExecutionObservers {
    private readonly listeners = new Map<symbol, ExecutionObserver>();
    private notifying = false;

    get isNotifying(): boolean {
        return this.notifying;
    }

    add(callback: ExecutionObserver): Observation {
        if (
            typeof callback !== "function" ||
            Object.prototype.toString.call(callback) === "[object AsyncFunction]"
        ) {
            throw new TypeError("Execution observers must be synchronous functions.");
        }

        if (this.listeners.size >= observersMax) {
            throw new RangeError("The world execution-observer limit was reached.");
        }

        const id = Symbol("observer");
        this.listeners.set(id, callback);

        return Object.freeze({
            [Symbol.dispose]: () => {
                this.listeners.delete(id);
            },
        });
    }

    notify(report: ExecutionReport): void {
        if (this.notifying) {
            throw new Error("Execution observer notification cannot reenter itself.");
        }

        const failures: unknown[] = [];
        this.notifying = true;

        try {
            const listeners = [...this.listeners];

            for (const [id, listener] of listeners) {
                if (!this.listeners.has(id)) {
                    continue;
                }

                try {
                    // JavaScript callbacks can violate the synchronous TypeScript contract.
                    // oxlint-disable-next-line typescript/no-confusing-void-expression
                    const result: unknown = listener(report);
                    assertSynchronousResult(result);
                } catch (error) {
                    failures.push(error);
                }
            }
        } finally {
            this.notifying = false;
        }

        if (failures.length > 0) {
            throw new ObserverError(failures, report.requestId, report.outcome);
        }
    }

    close(): void {
        this.listeners.clear();
    }
}

function assertSynchronousResult(value: unknown): void {
    if (
        value !== null &&
        (typeof value === "object" || typeof value === "function") &&
        "then" in value &&
        typeof value.then === "function"
    ) {
        void Promise.resolve(value).catch(() => {
            // The invalid asynchronous callback is reported synchronously to the request owner.
        });

        throw new TypeError("Execution observers cannot return Promises.");
    }
}
