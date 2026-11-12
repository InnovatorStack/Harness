import { assertActiveContext, hasContextAncestor } from "../../core/context.js";
import type { ExecutionContext } from "../../core/types.js";

interface MethodExecutionScope extends Disposable {
    readonly checkExecutionIdentity: boolean;
}

/** Native NoCheck follows a bound Method's call chain without adding an Identity grant. */
export class MethodExecutionScopes {
    private roots = new WeakSet<ExecutionContext>();

    enter(context: ExecutionContext, platformBound: boolean): MethodExecutionScope {
        assertActiveContext(context);
        const inherited = hasContextAncestor(context, (ancestor) => this.roots.has(ancestor));

        if (platformBound) {
            this.roots.add(context);
        }

        return {
            checkExecutionIdentity: !platformBound && !inherited,

            [Symbol.dispose]: () => {
                if (platformBound) {
                    this.roots.delete(context);
                }
            },
        };
    }

    reset(): void {
        this.roots = new WeakSet();
    }
}
