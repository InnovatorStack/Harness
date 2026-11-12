import type { HarnessStorage } from "./types.js";

const epochs = new WeakMap<HarnessStorage, number>();

/** Only storage with fully owned metadata writes may opt into derived catalog reuse. */
export function trackMetadata(storage: HarnessStorage): void {
    epochs.set(storage, 0);
}

export function changeMetadata(storage: HarnessStorage): void {
    const current = epochs.get(storage);

    if (current !== undefined) {
        epochs.set(storage, current + 1);
    }
}

export function metadataEpoch(storage: HarnessStorage): number | undefined {
    return epochs.get(storage);
}
