import { assertActiveContext } from "../core/context.js";
import { cloneFrozenData } from "../core/data.js";
import { traceBytesMax, traceEventsMax } from "../core/limits.js";
import type { ExecutionContext, TransactionOutcome } from "../core/types.js";
import type { SourceLocation } from "../diagnostics/source-location.js";
import type { ItemPayload } from "../items/item.js";
import type { MethodSourceResolution } from "../methods/sources.js";
import type { MockValue } from "../mocks/types.js";
import type { StoredItem } from "../storage/types.js";
import { PlatformError } from "./errors.js";

export interface SourceDefinition {
    readonly type: "Method" | "SQL";
    readonly id: string;
}

export interface PlatformTraceEvent {
    readonly sequence: number;
    readonly requestId: string;
    readonly executionId: string;
    readonly parentExecutionId?: string;
    readonly kind:
        | "action"
        | "event"
        | "method"
        | "execution"
        | "result"
        | "mock"
        | "mutation"
        | "seed"
        | "authorization";
    readonly name: string;
    readonly source?: SourceLocation;
    readonly sourceHash?: string;
    readonly methodSource?: MethodSourceResolution;
    readonly request?: Readonly<ItemPayload>;
    readonly result?: Readonly<ItemPayload>;
    readonly definition?: SourceDefinition;
    readonly mock?: {
        readonly definition: string;
        readonly responseFile?: string;
        readonly responseHash: string;
        readonly parameters: Readonly<Record<string, MockValue>>;
    };
    readonly before?: StoredItem;
    readonly after?: StoredItem;
    readonly outcome?: TransactionOutcome;
}

export class PlatformTrace {
    private readonly events: PlatformTraceEvent[] = [];
    private bytes = 0;

    constructor(private readonly observe?: (event: PlatformTraceEvent) => void) {}

    record(
        context: ExecutionContext,
        event: Omit<PlatformTraceEvent, "sequence" | "requestId" | "executionId" | "outcome">,
    ): void {
        assertActiveContext(context);

        if (this.events.length >= traceEventsMax) {
            context.fail(
                new PlatformError(
                    "ProtocolLimit",
                    "The platform trace event limit was reached. Reset the world.",
                ),
            );
        }

        const recorded = cloneFrozenData({
            ...event,
            sequence: this.events.length + 1,
            requestId: context.requestId,
            executionId: context.executionId,
            ...(context.parentExecutionId ? { parentExecutionId: context.parentExecutionId } : {}),
        });
        const bytes = JSON.stringify(recorded).length * 3;

        if (bytes > traceBytesMax - this.bytes) {
            context.fail(
                new PlatformError(
                    "ProtocolLimit",
                    "The platform trace byte limit was reached. Reset the world.",
                ),
            );
        }

        this.bytes += bytes;
        this.events.push(recorded);
        this.observe?.(recorded);
    }

    read(
        outcome: (requestId: string) => TransactionOutcome | undefined,
    ): readonly PlatformTraceEvent[] {
        return Object.freeze(
            this.events.map((event) => {
                const status = outcome(event.requestId);

                return Object.freeze({
                    ...event,
                    ...(status ? { outcome: status } : {}),
                });
            }),
        );
    }

    reset(): void {
        this.events.length = 0;
        this.bytes = 0;
    }
}
