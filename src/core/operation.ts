import { RuntimeError } from "./errors.js";
import type { AsyncHandler, SyncHandler } from "./types.js";

const bindings = Symbol("operation bindings");

export type OperationBinding<Input, Output> =
    | { readonly mode: "sync"; readonly handler: SyncHandler<Input, Output> }
    | { readonly mode: "async"; readonly handler: AsyncHandler<Input, Output> };

export interface Operation<Input, Output> {
    readonly name: string;
    readonly [bindings]: WeakMap<object, OperationBinding<Input, Output>>;
}

export function defineOperation<Input, Output>(name: string): Operation<Input, Output> {
    if (typeof name !== "string" || name.trim().length === 0 || name.length > 1024) {
        throw new RuntimeError("InvalidOperation", "An operation needs a non-empty name.");
    }

    return Object.freeze({
        name,
        [bindings]: new WeakMap<object, OperationBinding<Input, Output>>(),
    });
}

export function bindOperation<Input, Output>(
    operation: Operation<Input, Output>,
    owner: object,
    binding: OperationBinding<Input, Output>,
): () => void {
    operation[bindings].set(owner, binding);

    return () => {
        operation[bindings].delete(owner);
    };
}

export function getOperationBinding<Input, Output>(
    operation: Operation<Input, Output>,
    owner: object,
): OperationBinding<Input, Output> | undefined {
    return operation[bindings].get(owner);
}
