/** A deadline settles framework work; late extension callbacks still need their context checked. */
export class Deadline implements Disposable {
    private readonly controller = new AbortController();
    private readonly timer: ReturnType<typeof setTimeout>;
    private readonly expired: Promise<never>;

    constructor(timeoutMs: number, error: () => Error) {
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
            throw new TypeError("A deadline requires a positive integer timeout in milliseconds.");
        }

        this.expired = new Promise<never>((_resolve, reject) => {
            this.controller.signal.addEventListener(
                "abort",
                () => {
                    const reason: unknown = this.controller.signal.reason;
                    reject(reason);
                },
                {
                    once: true,
                },
            );
        });
        this.timer = setTimeout(() => this.cancel(error()), timeoutMs);
        // A synchronous owner can dispose without ever waiting on the deadline.
        void this.expired.catch(() => {
            // Disposal can precede the first waiter; wait() still observes this rejection.
        });
    }

    get signal(): AbortSignal {
        return this.controller.signal;
    }

    wait<Value>(work: PromiseLike<Value>): Promise<Value> {
        return Promise.race([work, this.expired]);
    }

    cancel(reason: unknown): void {
        this.controller.abort(reason);
    }

    [Symbol.dispose](): void {
        clearTimeout(this.timer);
        this.cancel(new Error("The deadline owner has finished."));
    }
}
