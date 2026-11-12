import { assertActiveContext } from "../../core/context.js";
import type { ExecutionContext } from "../../core/types.js";
import type { Item } from "../../items/item.js";
import type { MethodServerEvent } from "../../methods/types.js";
import { PlatformError } from "../errors.js";
import type { EventBinding } from "./types.js";

type ApplyBase = (request: Item, context: ExecutionContext) => Promise<Item>;

interface Frame {
    readonly owner: ExecutionContext;
    readonly binding: EventBinding;
    readonly name: string;
    readonly type: string;
    readonly action: string;
    readonly apply: ApplyBase;
}

/** A base delegate belongs to one replacement invocation, never to nested ordinary Methods. */
export class EventReplacements {
    private readonly frames = new Map<string, Frame>();

    async invoke(
        binding: EventBinding,
        name: string,
        item: Item,
        context: ExecutionContext,
        apply: ApplyBase,
        execute: () => Promise<Item>,
    ): Promise<Item> {
        const key = this.key(context.requestId, context.executionId);

        if (this.frames.has(key)) {
            throw new PlatformError("InvalidServerEvent", "Replacement frames cannot overlap.");
        }

        this.frames.set(key, {
            owner: context,
            binding,
            name,
            type: item.getType(),
            action: item.getAction(),
            apply,
        });

        try {
            return await execute();
        } finally {
            this.frames.delete(key);
        }
    }

    scope(
        methodId: string,
        context: ExecutionContext,
    ): (MethodServerEvent & Disposable) | undefined {
        const key = this.key(context.requestId, context.parentExecutionId ?? "");
        const frame = this.frames.get(key);

        if (!frame || frame.binding.methodId.toLowerCase() !== methodId.toLowerCase()) {
            return undefined;
        }

        let closed = false;

        return {
            name: frame.name,

            applyBase: (request) => {
                assertActiveContext(context);

                if (closed || this.frames.get(key) !== frame) {
                    throw new PlatformError(
                        "ExpiredServerEvent",
                        "The replacement event has completed.",
                    );
                }

                assertActiveContext(frame.owner);
                this.assertRequest(frame, request, context);

                return frame.apply(request, context);
            },

            [Symbol.dispose]: () => {
                closed = true;
            },
        };
    }

    private key(requestId: string, executionId: string): string {
        return JSON.stringify([requestId, executionId]);
    }

    private assertRequest(frame: Frame, request: Item, context: ExecutionContext): void {
        if (
            request.getItemCount() !== 1 ||
            request.getType().toLowerCase() !== frame.type.toLowerCase() ||
            request.getAction() !== frame.action
        ) {
            context.fail(
                new PlatformError(
                    "InvalidServerEventContext",
                    "A base action must retain the replacement ItemType and action.",
                ),
            );
        }
    }
}
