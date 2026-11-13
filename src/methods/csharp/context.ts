import type { Item, ItemPayload } from "../../items/item.js";
import { PlatformError } from "../../platform/errors.js";
import type { ManagedOrigins, OriginFrame } from "./origins.js";
import { RetainedItems, requiredOrigin } from "./retained-items.js";

/** The current document can change while action code still holds its original nodes. */
export class ManagedInput {
    readonly frame: OriginFrame;
    private readonly roots: readonly symbol[];
    private readonly retained: RetainedItems;

    constructor(
        private readonly context: Item,
        private readonly origins: ManagedOrigins,
    ) {
        this.frame = origins.capture(context.payload);
        this.roots = context.payload.items.map(requiredOrigin);
        this.retained = new RetainedItems(context.payload);
    }

    synchronize(message: Record<string, unknown>): void {
        if (message.contextError !== undefined) {
            throw managedFailure(message);
        }

        const input = message.contextIsResult === true ? message.payload : message.context;

        if (input === undefined && message.kind === "failure") {
            return;
        }

        const frame = message.contextIsResult === true ? message.origins : message.contextOrigins;
        const changed = this.origins.decode(input, frame);
        const retained = this.retainedInput(message);
        this.retained.synchronize(retained ? [changed, retained] : [changed]);

        for (const name of ["error", "result", "messages"] as const) {
            delete this.context.payload[name];
        }

        Object.assign(this.context.payload, changed);
    }

    private retainedInput(message: Record<string, unknown>): ItemPayload | undefined {
        if (message.retainedContext === undefined || message.retainedContext === null) {
            if (message.retainedOrigins !== undefined && message.retainedOrigins !== null) {
                throw new PlatformError("InvalidProtocol", "Retained Item origins have no input.");
            }

            return undefined;
        }

        const payload = this.origins.decode(message.retainedContext, message.retainedOrigins);

        if (
            payload.error !== undefined ||
            payload.result !== undefined ||
            payload.messages !== undefined ||
            payload.items.length !== this.roots.length ||
            payload.items.some((node, index) => requiredOrigin(node) !== this.roots[index])
        ) {
            throw new PlatformError(
                "InvalidProtocol",
                "Retained Method input must preserve its original selected Item identities.",
            );
        }

        return payload;
    }
}

export function managedFailure(message: Record<string, unknown>): PlatformError {
    let error =
        typeof message.error === "string" ? message.error : "Invalid managed failure response.";

    if (typeof message.contextError === "string") {
        error += `\nFailed to synchronize Method input: ${message.contextError}`;
    }

    return new PlatformError("MethodExecutionFailed", error);
}
