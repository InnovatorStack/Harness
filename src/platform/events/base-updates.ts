import { assertActiveContext } from "../../core/context.js";
import type { ExecutionContext } from "../../core/types.js";
import type { Item, ItemNode } from "../../items/item.js";
import { PlatformError } from "../errors.js";

interface CapturedMutation {
    readonly ids: readonly string[];
    readonly enabled: boolean;
    readonly fetch: boolean;
}

/** Target selection and execution flags survive changes to replacement-owned XML. */
export class BaseUpdates {
    private readonly active = new WeakMap<Item, CapturedMutation>();

    enter(
        item: Item,
        id: string,
        attributes: Readonly<Record<string, string>>,
        context: ExecutionContext,
    ): Disposable {
        assertActiveContext(context);

        if (this.active.has(item)) {
            throw new PlatformError(
                "InvalidServerEvent",
                "Overlapping base updates cannot share the same pending input.",
            );
        }

        this.active.set(item, {
            ids: [id],
            enabled: attributes.serverEvents !== "0",
            fetch: attributes.doGetItem !== "0",
        });

        return {
            [Symbol.dispose]: () => {
                this.active.delete(item);
            },
        };
    }

    targets(item: Item): readonly string[] | undefined {
        return this.active.get(item)?.ids;
    }

    enabled(item: Item): boolean | undefined {
        return this.active.get(item)?.enabled;
    }

    response(item: Item): ItemNode {
        const captured = this.active.get(item);

        if (!captured) {
            return item.node;
        }

        return {
            ...item.node,
            attributes: {
                ...item.node.attributes,
                serverEvents: captured.enabled ? "1" : "0",
                doGetItem: captured.fetch ? "1" : "0",
            },
        };
    }
}
