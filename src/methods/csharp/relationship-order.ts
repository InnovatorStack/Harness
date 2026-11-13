import { dataNodesMax } from "../../core/limits.js";
import type { ItemNode } from "../../items/item.js";
import { PlatformError } from "../../platform/errors.js";
import { relationshipKey } from "../../platform/graph-actions.js";

export interface RelationshipPosition {
    readonly before?: number;
    readonly after?: number;
}

interface Candidates {
    readonly positions: number[];
    cursor: number;
}

export type RequestCopyId = (type: string, id: string) => string;

/** Saved identities survive version-copy rewrites; repeated requests retain occurrence order. */
export function relationshipOrder(
    before: readonly ItemNode[],
    after: readonly ItemNode[],
    copyId: RequestCopyId,
): readonly RelationshipPosition[] {
    const candidates = new Map<string, Candidates>();
    const used = new Set<number>();
    const result: RelationshipPosition[] = [];
    const budget = { remaining: dataNodesMax };

    for (const [index, node] of before.entries()) {
        const id = node.attributes.id ?? "";
        const key = relationshipKey(node.type, id ? copyId(node.type, id) : "");
        const group = candidates.get(key) ?? { positions: [], cursor: 0 };
        group.positions.push(index);
        candidates.set(key, group);
    }

    for (const [index, node] of after.entries()) {
        const id = node.attributes.id ?? "";
        const group =
            candidates.get(relationshipKey(node.type, id)) ??
            candidates.get(relationshipKey(node.type, ""));
        const previous = chooseCandidate(group, before, node, used, budget);

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

function chooseCandidate(
    group: Candidates | undefined,
    before: readonly ItemNode[],
    after: ItemNode,
    used: ReadonlySet<number>,
    budget: { remaining: number },
): number | undefined {
    if (!group) {
        return undefined;
    }

    while (group.cursor < group.positions.length && used.has(group.positions[group.cursor] ?? -1)) {
        group.cursor += 1;
    }

    if (group.positions.length < 2) {
        return group.positions[group.cursor];
    }

    for (let index = group.cursor; index < group.positions.length; index += 1) {
        const position = group.positions[index];
        const previous = position === undefined ? undefined : before[position];

        if (--budget.remaining < 0) {
            throw new PlatformError(
                "ProtocolLimit",
                "Relationship identity matching exceeds its budget.",
            );
        }

        if (
            position !== undefined &&
            previous &&
            !used.has(position) &&
            sameBody(previous, after)
        ) {
            return position;
        }
    }

    if (group.cursor === group.positions.length) {
        return undefined;
    }

    throw new PlatformError(
        "UnsupportedRequestIdentity",
        "Changed requests with repeated or missing relationship IDs require unambiguous node identity.",
    );
}

function sameBody(before: ItemNode, after: ItemNode): boolean {
    const { id: _beforeId, ...beforeAttributes } = before.attributes;
    const { id: _afterId, ...afterAttributes } = after.attributes;
    const { source_id: _beforeSource, ...beforeProperties } = before.properties;
    const { source_id: _afterSource, ...afterProperties } = after.properties;

    return Bun.deepEquals(
        { ...before, attributes: beforeAttributes, properties: beforeProperties },
        { ...after, attributes: afterAttributes, properties: afterProperties },
    );
}
