import { freezeData } from "../core/data.js";
import { metadataEpoch } from "../storage/metadata-epoch.js";
import type { HarnessStorage } from "../storage/types.js";
import { bootstrapSource } from "./bootstrap.js";
import { entryKey } from "./draft.js";
import type { DraftEntry } from "./draft.js";

const baselineViews = new WeakMap<Uint8Array, readonly DraftEntry[]>();
const activeBaselines = new WeakMap<HarnessStorage, readonly DraftEntry[]>();

/** A freshly restored built-in database has the same initial records in every configured setup. */
export function withImportBaseline<Result>(
    storage: HarnessStorage,
    image: Uint8Array,
    run: () => Result,
): Result {
    if (metadataEpoch(storage) === undefined) {
        return run();
    }

    let entries = baselineViews.get(image);

    if (!entries) {
        entries = freezeData([...readImportState(storage).values()]);
        baselineViews.set(image, entries);
    }

    if (activeBaselines.has(storage)) {
        throw new Error("A built-in import baseline cannot be entered twice.");
    }

    activeBaselines.set(storage, entries);

    try {
        return run();
    } finally {
        activeBaselines.delete(storage);
    }
}

export function readImportState(storage: HarnessStorage): Map<string, DraftEntry> {
    const entries = new Map<string, DraftEntry>();
    const initial = activeBaselines.get(storage);

    if (initial) {
        for (const entry of initial) {
            entries.set(entryKey(entry.type, entry.id), {
                ...entry,
                properties: { ...entry.properties },
            });
        }

        return entries;
    }

    const definitions = storage.listItemTypes();
    const physicalTypes = new Set(definitions.map((definition) => definition.name.toLowerCase()));
    const catalog = new Map(
        storage.listCatalogEntries().map((entry) => [entryKey(entry.type, entry.id), entry]),
    );

    for (const [key, entry] of catalog) {
        if (!physicalTypes.has(entry.type.toLowerCase())) {
            entries.set(key, { ...entry, properties: { ...entry.properties } });
        }
    }

    for (const definition of definitions) {
        for (const item of storage.listItems(definition.name)) {
            const key = entryKey(item.type, item.id);
            const metadata = catalog.get(key);
            entries.set(key, {
                ...item,
                properties: { ...item.properties },
                attributes: metadata?.attributes ?? {},
                source: metadata?.source ?? bootstrapSource(`/database/${item.type}/${item.id}`),
            });
        }
    }

    return entries;
}
