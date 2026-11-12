import { RuntimeError } from "./errors.js";
import type { ExecutionContext } from "./types.js";

interface ContextOwner {
    readonly assertActive: () => void;
    readonly spend: (units: number) => void;
}

const contexts = new WeakMap<ExecutionContext, ContextOwner>();

export function registerContext(
    context: ExecutionContext,
    assertActive: () => void,
    spend: (units: number) => void,
): void {
    contexts.set(context, { assertActive, spend });
}

/** Internal ports must reject late callbacks before they touch data or instrumentation. */
export function assertActiveContext(context: ExecutionContext): void {
    const owner = contexts.get(context);

    if (!owner) {
        throw new RuntimeError(
            "InvalidOperation",
            "The execution context does not belong to a runtime.",
        );
    }

    owner.assertActive();
}

export function spendContext(context: ExecutionContext, units = 1): void {
    assertActiveContext(context);
    const owner = contexts.get(context);

    if (!owner) {
        throw new Error("An active context must have an owner.");
    }

    owner.spend(units);
}
