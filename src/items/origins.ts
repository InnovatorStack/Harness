import { cloneData } from "../core/data.js";
import { dataDepthMax, dataNodesMax } from "../core/limits.js";
import type { ItemNode, ItemPayload } from "./item.js";
import type { AmlLogicalTerm } from "./logical.js";

type Frame =
    | { readonly node: ItemNode; readonly depth: number }
    | { readonly term: AmlLogicalTerm; readonly depth: number };

const origins = new WeakMap<ItemNode, symbol>();

export function itemOrigin(node: ItemNode): symbol | undefined {
    return origins.get(node);
}

export function bindItemOrigin(node: ItemNode, origin: symbol): void {
    origins.set(node, origin);
}

/** Origin metadata belongs to pending Items, never to business AML or stored records. */
export function cloneItemPayload(payload: ItemPayload): ItemPayload {
    const result = cloneData(payload);
    const copied = itemNodes(result);

    for (const original of itemNodes(payload)) {
        const next = copied.next();

        if (next.done) {
            throw new Error("An Item clone must retain the complete source tree.");
        }

        const origin = origins.get(original);

        if (origin !== undefined) {
            origins.set(next.value, origin);
        }
    }

    if (!copied.next().done) {
        throw new Error("An Item clone cannot introduce new source nodes.");
    }

    return result;
}

// Shared wire order: logical Items, ordinal property Items, then ordered relationships.
export function* itemNodes(payload: ItemPayload): Generator<ItemNode> {
    if (payload.items.length > dataNodesMax) {
        throw new TypeError("Item origins exceed their root limit.");
    }

    const pending: Frame[] = [];

    for (let index = payload.items.length - 1; index >= 0; index -= 1) {
        const node = payload.items[index];

        if (node) {
            pending.push({ node, depth: 0 });
        }
    }

    let visited = 0;

    while (pending.length > 0) {
        const frame = pending.pop();

        if (
            !frame ||
            ++visited > dataNodesMax ||
            frame.depth > dataDepthMax ||
            pending.length > dataNodesMax
        ) {
            throw new TypeError("Item origins exceed their node or nesting limit.");
        }

        if ("term" in frame) {
            appendLogical(frame.term, frame.depth, pending);
            continue;
        }

        yield frame.node;
        appendChildren(frame.node, frame.depth, pending);

        if (pending.length > dataNodesMax) {
            throw new TypeError("Item origins exceed their pending node limit.");
        }
    }
}

function appendChildren(node: ItemNode, depth: number, pending: Frame[]): void {
    const names = Object.keys(node.propertyItems).sort().reverse();
    const children = node.relationships.length + names.length + (node.logical?.length ?? 0);

    if (children > dataNodesMax - pending.length) {
        throw new TypeError("Item origins exceed their pending node limit.");
    }

    for (let index = node.relationships.length - 1; index >= 0; index -= 1) {
        const child = node.relationships[index];

        if (child) {
            pending.push({ node: child, depth: depth + 1 });
        }
    }

    for (const name of names) {
        const child = node.propertyItems[name];

        if (child) {
            pending.push({ node: child, depth: depth + 1 });
        }
    }

    for (let index = (node.logical?.length ?? 0) - 1; index >= 0; index -= 1) {
        const term = node.logical?.[index];

        if (term) {
            pending.push({ term, depth: depth + 1 });
        }
    }
}

function appendLogical(term: AmlLogicalTerm, depth: number, pending: Frame[]): void {
    if ("operator" in term) {
        if (term.terms.length > dataNodesMax - pending.length) {
            throw new TypeError("Item origins exceed their pending node limit.");
        }

        for (let index = term.terms.length - 1; index >= 0; index -= 1) {
            const child = term.terms[index];

            if (child) {
                pending.push({ term: child, depth: depth + 1 });
            }
        }
    } else if (term.item) {
        pending.push({ node: term.item, depth: depth + 1 });
    }
}
