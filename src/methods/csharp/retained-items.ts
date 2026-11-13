import { setOwn } from "../../core/data.js";
import type { ItemNode, ItemPayload } from "../../items/item.js";
import { decodeLogical } from "../../items/logical.js";
import { itemNodes, itemOrigin } from "../../items/origins.js";
import { PlatformError } from "../../platform/errors.js";

/** Reconcile one invocation's wire projections without rebinding retained Item nodes. */
export class RetainedItems {
    private readonly original = new Map<symbol, ItemNode>();

    constructor(payload: ItemPayload) {
        for (const node of itemNodes(payload)) {
            this.original.set(requiredOrigin(node), node);
        }
    }

    synchronize(payloads: readonly ItemPayload[]): void {
        const sources = new Map<symbol, ItemNode>();
        const canonical = new Map<unknown, ItemNode>();

        for (const payload of payloads) {
            for (const node of itemNodes(payload)) {
                const origin = requiredOrigin(node);
                const previous = sources.get(origin);

                if (previous && !sameProjection(previous, node)) {
                    throw new PlatformError(
                        "InvalidProtocol",
                        "Managed document and retained input disagree about the same Item.",
                    );
                }

                const source = previous ?? node;
                sources.set(origin, source);
                canonical.set(node, this.original.get(origin) ?? source);
            }
        }

        const patches = [...sources.values()].map((source) => ({
            target: requireCanonical(canonical, source),
            projection: projectNode(source, canonical),
        }));
        const roots = payloads.map((payload) =>
            payload.items.map((node) => requireCanonical(canonical, node)),
        );

        // Validate every projection before changing any retained caller object.
        for (const { target, projection } of patches) {
            Object.assign(target, projection);

            if (projection.logical === undefined) {
                delete target.logical;
            }
        }

        for (const [index, payload] of payloads.entries()) {
            const selected = roots[index];

            if (!selected) {
                throw new Error("Every managed payload must retain its projected roots.");
            }

            payload.items = selected;
        }
    }
}

function projectNode(source: ItemNode, canonical: ReadonlyMap<unknown, ItemNode>): ItemNode {
    const propertyItems: Record<string, ItemNode> = {};

    for (const [name, item] of Object.entries(source.propertyItems)) {
        setOwn(propertyItems, name, requireCanonical(canonical, item));
    }

    return {
        type: source.type,
        attributes: source.attributes,
        properties: source.properties,
        propertyAttributes: source.propertyAttributes,
        propertyItems,
        relationships: source.relationships.map((node) => requireCanonical(canonical, node)),
        ...(source.logical
            ? {
                  logical: decodeLogical(source.logical, (node) =>
                      requireCanonical(canonical, node),
                  ),
              }
            : {}),
    };
}

function requireCanonical(canonical: ReadonlyMap<unknown, ItemNode>, node: unknown): ItemNode {
    const selected = canonical.get(node);

    if (!selected) {
        throw new PlatformError("InvalidProtocol", "A managed Item projection has no source.");
    }

    return selected;
}

export function requiredOrigin(node: ItemNode): symbol {
    const origin = itemOrigin(node);

    if (origin === undefined) {
        throw new PlatformError("InvalidProtocol", "A managed Item has no invocation origin.");
    }

    return origin;
}

function sameProjection(left: ItemNode, right: ItemNode): boolean {
    if (!Bun.deepEquals(left, right)) {
        return false;
    }

    const previous = itemNodes({ items: [left] });

    for (const node of itemNodes({ items: [right] })) {
        const selected = previous.next();

        if (selected.done || requiredOrigin(selected.value) !== requiredOrigin(node)) {
            return false;
        }
    }

    return previous.next().done === true;
}
