import type { HarnessStorage, ItemTypeDefinition } from "../storage/types.js";
import { PlatformError } from "./errors.js";

/** Manual versioning never starts a generation implicitly during an ordinary update. */
export function manualVersioning(storage: HarnessStorage, definition: ItemTypeDefinition): boolean {
    const metadata = storage.getCatalogEntry("ItemType", definition.id);
    const value = String(metadata?.properties.manual_versioning ?? "0");

    if (value !== "0" && value !== "1") {
        throw new PlatformError(
            "UnsupportedVersioningPolicy",
            `Unknown manual_versioning '${value}' on '${definition.name}'.`,
        );
    }

    return value === "1";
}
