import { dataDepthMax, dataNodesMax } from "../../core/limits.js";
import type { SourceLocation } from "../../diagnostics/source-location.js";
import type { HarnessStorage } from "../../storage/types.js";
import { PlatformError } from "../errors.js";

interface Parent {
    readonly id: string;
    readonly source: SourceLocation;
}

interface Frame {
    readonly id: string;
    readonly depth: number;
    readonly exit: boolean;
    readonly source?: SourceLocation;
}

/** Morphae inheritance affects event dispatch without requiring polymorphic record storage. */
export function eventOwners(storage: HarnessStorage, typeId: string): ReadonlySet<string> {
    const parents = parentBindings(storage);
    const owners = new Set<string>();
    const active = new Set<string>();
    const pending: Frame[] = [{ id: typeId.toLowerCase(), depth: 0, exit: false }];
    let visited = 0;

    while (pending.length > 0) {
        const frame = pending.pop();

        if (!frame || frame.depth > dataDepthMax || ++visited > dataNodesMax) {
            throw new PlatformError("ProtocolLimit", "Event inheritance exceeds its graph budget.");
        }

        if (frame.exit) {
            active.delete(frame.id);
            continue;
        }

        if (active.has(frame.id)) {
            throw new PlatformError(
                "EventInheritanceCycle",
                `Cyclic Morphae inheritance at '${frame.id}'.`,
                frame.source ? { source: frame.source } : undefined,
            );
        }

        if (owners.has(frame.id)) {
            continue;
        }

        owners.add(frame.id);
        active.add(frame.id);
        pending.push({ ...frame, exit: true });

        for (const parent of parents.get(frame.id) ?? []) {
            if (pending.length >= dataNodesMax) {
                throw new PlatformError("ProtocolLimit", "Event inheritance queue is too large.");
            }

            pending.push({ ...parent, depth: frame.depth + 1, exit: false });
        }
    }

    return owners;
}

function parentBindings(storage: HarnessStorage): ReadonlyMap<string, readonly Parent[]> {
    const parents = new Map<string, Parent[]>();

    for (const entry of storage.listCatalogEntries("Morphae")) {
        const owner = entry.properties.source_id;
        const related = entry.properties.related_id;

        if (typeof owner !== "string" || typeof related !== "string") {
            throw new PlatformError(
                "InvalidEventInheritance",
                "Morphae requires source and related ItemTypes.",
                { source: entry.source },
            );
        }

        const metadata = storage.getCatalogEntry("ItemType", owner);

        if (String(metadata?.properties.implementation_type).toLowerCase() !== "polymorphic") {
            throw new PlatformError(
                "InvalidEventInheritance",
                "Morphae must be owned by a polymorphic ItemType.",
                { source: entry.source },
            );
        }

        const key = related.toLowerCase();
        const values = parents.get(key) ?? [];
        values.push({ id: owner.toLowerCase(), source: entry.source });
        parents.set(key, values);
    }

    return parents;
}
