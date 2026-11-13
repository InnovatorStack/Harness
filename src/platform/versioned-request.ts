import { spendContext } from "../core/context.js";
import { dataDepthMax, dataNodesMax } from "../core/limits.js";
import type { ExecutionContext } from "../core/types.js";
import type { Item, ItemNode } from "../items/item.js";
import type { HarnessStorage, StoredItem } from "../storage/types.js";
import { PlatformError } from "./errors.js";
import { relationshipKey } from "./graph-actions.js";
import { isReleased, removeRevisionProperties } from "./revisions/policy.js";

export interface VersionTarget {
    readonly record: StoredItem;
    readonly copies: ReadonlyMap<string, string>;
}

interface VersionCriteria {
    readonly scalar: boolean;
    readonly oldId: string;
}

export function versionCriteria(
    original: Item,
    sources: readonly StoredItem[],
    fromUpdate: boolean,
): VersionCriteria {
    if (fromUpdate) {
        return {
            scalar: sources.length === 1,
            oldId: sources.map((source) => source.id).join(","),
        };
    }

    const id = original.getID();

    if (id) {
        return { scalar: true, oldId: id };
    }

    const idList = original.getAttribute("idlist");

    if (idList) {
        const ids = idList.split(",").map((value) => value.trim());

        return { scalar: ids.length === 1, oldId: ids.join(",") };
    }

    return {
        scalar: false,
        oldId: ` ( ${original.getAttribute("where")} ) /*WhereClauseHelper marker*/ `,
    };
}

/** Generated updates retain native criteria, but never repeat the version decision. */
export function versionedRequest(
    criteria: VersionCriteria,
    pending: Item,
    sources: readonly StoredItem[],
    targets: readonly VersionTarget[],
    automatic: boolean,
): Item {
    const request = pending.clone();
    request.setAttribute("oldId", criteria.oldId);
    delete request.node.attributes.id;
    delete request.node.attributes.where;
    delete request.node.attributes.idlist;

    if (criteria.scalar) {
        const target = targets[0];

        if (!target) {
            throw new PlatformError("InvalidGeneration", "A generated update target is missing.");
        }

        request.setProperty("id", target.record.id);
    } else {
        request.setAttribute("idlist", targets.map((target) => target.record.id).join(","));
    }

    for (const [index, source] of sources.entries()) {
        const target = targets[index];

        if (!target) {
            throw new PlatformError("InvalidGeneration", "A generated update target is missing.");
        }

        if (isReleased(source)) {
            removeRevisionProperties(request, source, target.record);
        }
    }

    if (automatic) {
        request.setProperty("new_version", 1);
    }

    return request;
}

/** Replacement Methods see copied relationship IDs before deciding whether to apply the update. */
export function remapVersionRelationships(
    storage: HarnessStorage,
    request: Item,
    copies: ReadonlyMap<string, string>,
    context: ExecutionContext,
): void {
    const pending = [{ node: request.node, depth: 0, relationship: false }];
    let visited = 0;

    while (pending.length > 0) {
        spendContext(context);
        const frame = pending.pop();

        if (!frame || ++visited > dataNodesMax || frame.depth > dataDepthMax) {
            throw new PlatformError("ProtocolLimit", "Versioned relationships exceed their limit.");
        }

        if (frame.relationship) {
            remapRelationship(storage, frame.node, copies);
        }

        for (const node of frame.node.relationships) {
            pending.push({ node, depth: frame.depth + 1, relationship: true });
        }

        for (const node of Object.values(frame.node.propertyItems)) {
            pending.push({ node, depth: frame.depth + 1, relationship: false });
        }
    }
}

function remapRelationship(
    storage: HarnessStorage,
    node: ItemNode,
    copies: ReadonlyMap<string, string>,
): void {
    const originalId = node.attributes.id;
    const id = originalId ? copies.get(relationshipKey(node.type, originalId)) : undefined;

    if (!originalId || !id) {
        return;
    }

    const previous = storage.getItem(node.type, originalId);
    const current = storage.getItem(node.type, id);
    const source = node.properties.source_id;

    if (
        source !== undefined &&
        String(source).toLowerCase() === String(previous?.properties.source_id).toLowerCase() &&
        current?.properties.source_id !== undefined
    ) {
        node.properties.source_id = current.properties.source_id;
    }

    node.attributes.id = id;
}
