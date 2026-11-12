import { RuntimeError } from "./errors.js";
import { requestDepthMax } from "./limits.js";
import type { ExecutionContext } from "./types.js";

interface ContextOwner {
    readonly assertActive: () => void;
    readonly spend: (units: number) => void;
    readonly parent: ExecutionContext | undefined;
}

const contexts = new WeakMap<ExecutionContext, ContextOwner>();

export function registerContext(
    context: ExecutionContext,
    assertActive: () => void,
    spend: (units: number) => void,
    parent?: ExecutionContext,
): void {
    contexts.set(context, { assertActive, spend, parent });
}

/** Internal scopes follow the runtime's actual ancestry, including extension operations. */
export function hasContextAncestor(
    context: ExecutionContext,
    matches: (ancestor: ExecutionContext) => boolean,
): boolean {
    assertActiveContext(context);
    let current: ExecutionContext | undefined = context;

    for (let depth = 0; current && depth <= requestDepthMax; depth += 1) {
        if (matches(current)) {
            return true;
        }

        current = contexts.get(current)?.parent;
    }

    if (current) {
        throw new RuntimeError("InvalidOperation", "Execution ancestry exceeds its depth limit.");
    }

    return false;
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
