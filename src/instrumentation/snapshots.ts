import { cloneFrozenData, isFrozenData, setOwn, getOwn } from "../core/data.js";
import { dataNodesMax } from "../core/limits.js";
import { Item } from "../items/item.js";
import type { ExecutionValue } from "./types.js";

export interface SnapshotLimits {
    readonly bytes: number;
    readonly snapshotBytes: number;
    readonly depth: number;
}

interface SnapshotState {
    bytes: number;
    nodes: number;
    readonly ancestors: Set<object>;
}

type SnapshotTask =
    | {
          readonly kind: "copy";
          readonly value: unknown;
          readonly depth: number;
          readonly write: (value: ExecutionValue) => void;
      }
    | {
          readonly kind: "close";
          readonly source: object;
          readonly output: object;
      };

class SnapshotIssueError extends Error {
    override readonly name = "SnapshotIssueError";
}

/** Bounded copies never call user getters or retain live request/result objects. */
export class Snapshots {
    private bytes = 0;
    omitted = 0;

    constructor(private readonly limits: SnapshotLimits) {
        for (const limit of [limits.bytes, limits.snapshotBytes, limits.depth]) {
            if (!Number.isSafeInteger(limit) || limit < 1) {
                throw new TypeError("Snapshot limits must be positive safe integers.");
            }
        }
    }

    value(value: unknown): ExecutionValue | undefined {
        if (value === undefined) {
            return undefined;
        }

        try {
            const state: SnapshotState = { bytes: 0, nodes: 0, ancestors: new Set() };
            const result = this.copy(value, state);
            this.bytes += state.bytes;

            return result;
        } catch (error) {
            if (!(error instanceof SnapshotIssueError)) {
                throw error;
            }

            this.omitted += 1;

            return undefined;
        }
    }

    record<Value extends object>(value: Value): Value | undefined {
        // Platform records are validated data. Their public types survive native cloning.
        if (this.value(value) === undefined) {
            return undefined;
        }

        return isFrozenData(value) ? value : cloneFrozenData(value);
    }

    private copy(value: unknown, state: SnapshotState): ExecutionValue {
        let result: ExecutionValue | undefined;
        const pending: SnapshotTask[] = [
            {
                kind: "copy",
                value,
                depth: 0,

                write: (value) => {
                    result = value;
                },
            },
        ];

        while (pending.length > 0) {
            const task = pending.pop();

            if (!task) {
                throw new Error("A snapshot task must exist while traversal is pending.");
            }

            if (task.kind === "close") {
                state.ancestors.delete(task.source);
                Object.freeze(task.output);
            } else {
                this.copyStep(task, state, pending);
            }
        }

        if (result === undefined) {
            throw new Error("A completed snapshot must have a value.");
        }

        return result;
    }

    private copyStep(
        task: Extract<SnapshotTask, { kind: "copy" }>,
        state: SnapshotState,
        pending: SnapshotTask[],
    ): void {
        state.nodes += 1;

        if (task.depth > this.limits.depth || state.nodes > dataNodesMax) {
            throw new SnapshotIssueError("Snapshot traversal limit");
        }

        const value = task.value;

        if (value instanceof Item) {
            pending.push({ ...task, value: value.payload });

            return;
        }

        if (value === null || typeof value === "boolean") {
            this.reserve(state, 5);
            task.write(value);
        } else if (typeof value === "number" && Number.isFinite(value)) {
            this.reserve(state, 24);
            task.write(value);
        } else if (typeof value === "string") {
            this.reserve(state, value.length * 3 + 2);
            task.write(value);
        } else if (typeof value === "object" && value !== null) {
            if (state.ancestors.has(value)) {
                throw new SnapshotIssueError("Snapshot is not a finite data tree");
            }

            this.copyChildren(value, task, state, pending);
        } else {
            throw new SnapshotIssueError("Snapshot has an unsupported value");
        }
    }

    private copyChildren(
        value: object,
        task: Extract<SnapshotTask, { kind: "copy" }>,
        state: SnapshotState,
        pending: SnapshotTask[],
    ): void {
        const descriptors = snapshotDescriptors(value);
        state.ancestors.add(value);

        if (Array.isArray(value)) {
            const output: ExecutionValue[] = [];
            task.write(output);
            pending.push({ kind: "close", source: value, output });

            for (let index = value.length - 1; index >= 0; index -= 1) {
                const descriptor = getOwn(descriptors, String(index));

                if (!descriptor || descriptor.get || descriptor.set) {
                    throw new SnapshotIssueError("Snapshot accessor or sparse array");
                }

                this.reserve(state, 1);
                pending.push({
                    kind: "copy",
                    value: descriptor.value,
                    depth: task.depth + 1,

                    write: (value) => {
                        output[index] = value;
                    },
                });
            }

            return;
        }

        const output: Record<string, ExecutionValue> = {};
        task.write(output);
        pending.push({ kind: "close", source: value, output });

        for (const [name, descriptor] of Object.entries(descriptors).reverse()) {
            if (!descriptor.enumerable) {
                continue;
            }

            if (descriptor.get || descriptor.set) {
                throw new SnapshotIssueError("Snapshot accessor");
            }

            if (descriptor.value === undefined) {
                continue;
            }

            this.reserve(state, name.length * 3 + 3);
            pending.push({
                kind: "copy",
                value: descriptor.value,
                depth: task.depth + 1,

                write: (value) => setOwn(output, name, value),
            });
        }
    }

    private reserve(state: SnapshotState, bytes: number): void {
        state.bytes += bytes;

        if (
            state.bytes > this.limits.snapshotBytes ||
            this.bytes + state.bytes > this.limits.bytes
        ) {
            throw new SnapshotIssueError("Snapshot size limit");
        }
    }
}

function snapshotDescriptors(value: object): Record<string, PropertyDescriptor> {
    try {
        if (!Array.isArray(value) && !isPlainObject(value)) {
            throw new SnapshotIssueError("Snapshot has an unsupported prototype");
        }

        return Object.getOwnPropertyDescriptors(value);
    } catch (error) {
        // Reflection on a Proxy can fail even when no getter is evaluated.
        throw new SnapshotIssueError("Snapshot reflection failed", { cause: error });
    }
}

function isPlainObject(value: object): boolean {
    const prototype: unknown = Object.getPrototypeOf(value);

    return prototype === Object.prototype || prototype === null;
}
