import { importFramesMax, dataNodesMax } from "../core/limits.js";

export interface ImportWork {
    advance(): ImportWork | null;
    abort(error: unknown): void;
}

/** A suspended metadata operation. Only the evaluator advances nested operations. */
export class ImportTask<Value> implements ImportWork {
    private result: { readonly value: Value } | undefined;

    constructor(private readonly program: Generator<ImportWork, Value, void>) {}

    advance(): ImportWork | null {
        const step = this.program.next();

        if (step.done) {
            this.result = { value: step.value };

            return null;
        }

        return step.value;
    }

    value(): Value {
        if (!this.result) {
            throw new Error("An import task cannot be read before it completes.");
        }

        return this.result.value;
    }

    abort(error: unknown): void {
        this.program.throw(error);
    }
}

/** Explicit interpreter stack preserves AML action order and unwinds selector guards on failure. */
export function evaluateImport<Value>(root: ImportTask<Value>): Value {
    const pending: ImportWork[] = [root];
    let steps = 0;

    try {
        while (pending.length > 0) {
            steps += 1;

            if (steps > dataNodesMax || pending.length > importFramesMax) {
                throw new TypeError("Package evaluation exceeded its work or nesting limit.");
            }

            const current = pending.at(-1);

            if (!current) {
                throw new Error("An import task must exist while evaluation is pending.");
            }

            const child = current.advance();

            if (child === null) {
                pending.pop();
            } else {
                pending.push(child);
            }
        }
    } catch (error) {
        const failures = [error];

        for (const task of pending.reverse()) {
            try {
                task.abort(error);
            } catch (cleanupError) {
                if (cleanupError !== error) {
                    failures.push(cleanupError);
                }
            }
        }

        if (failures.length > 1) {
            throw new AggregateError(failures, "Package evaluation and unwinding failed.", {
                cause: error,
            });
        }

        throw error;
    }

    return root.value();
}
