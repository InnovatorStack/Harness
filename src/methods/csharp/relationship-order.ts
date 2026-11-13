import { dataNodesMax } from "../../core/limits.js";
import type { ItemNode } from "../../items/item.js";
import { itemOrigin } from "../../items/origins.js";
import { PlatformError } from "../../platform/errors.js";

export interface RelationshipPosition {
    readonly before?: number;
    readonly after?: number;
}

/** Only pending node origins establish XML identity; business IDs and values can repeat. */
export function relationshipOrder(
    before: readonly ItemNode[],
    after: readonly ItemNode[],
): readonly RelationshipPosition[] {
    if (before.length > dataNodesMax || after.length > dataNodesMax) {
        throw new PlatformError("ProtocolLimit", "Relationship origins exceed their node limit.");
    }

    const origins = originalPositions(before);
    const seen = new Set<symbol>();
    const used = new Set<number>();
    const result: RelationshipPosition[] = [];

    for (const [index, node] of after.entries()) {
        const origin = itemOrigin(node);

        if (origin !== undefined) {
            if (seen.has(origin)) {
                throw new PlatformError("InvalidProtocol", "A relationship origin is duplicated.");
            }

            seen.add(origin);
        }

        const previous = origin === undefined ? undefined : origins.get(origin);

        if (previous === undefined) {
            result.push({ after: index });
        } else {
            used.add(previous);
            result.push({ before: previous, after: index });
        }
    }

    for (let index = 0; index < before.length; index += 1) {
        if (!used.has(index)) {
            result.push({ before: index });
        }
    }

    return result;
}

function originalPositions(before: readonly ItemNode[]): ReadonlyMap<symbol, number> {
    const result = new Map<symbol, number>();

    for (const [index, node] of before.entries()) {
        const origin = itemOrigin(node);

        if (origin === undefined) {
            throw new PlatformError(
                "UnsupportedRequestIdentity",
                "Untracked relationship requests require native node identity.",
            );
        }

        if (result.has(origin)) {
            throw new PlatformError("InvalidProtocol", "A relationship origin is duplicated.");
        }

        result.set(origin, index);
    }

    return result;
}
