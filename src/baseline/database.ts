import { readFileSync } from "node:fs";

import { PackageImporter } from "../packages/importer.js";
import { SqliteStorage } from "../storage/sqlite/storage.js";

let image: Uint8Array | undefined;

/** The published package ships this image; source development prepares it once in memory. */
export function builtinDatabase(): Uint8Array {
    if (image) {
        return image;
    }

    try {
        image = readFileSync(Bun.fileURLToPath(new URL("database.bin", import.meta.url)));
    } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
            throw error;
        }

        image = prepareBuiltinDatabase();
    }

    return image;
}

export function prepareBuiltinDatabase(): Uint8Array {
    const storage = new SqliteStorage();

    try {
        storage.transactions.begin();
        new PackageImporter(storage).import([]);
        storage.transactions.commit();

        return storage.snapshot();
    } finally {
        storage.close();
    }
}
