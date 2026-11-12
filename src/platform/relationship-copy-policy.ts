import type { HarnessStorage, ItemTypeDefinition, StoredItem } from "../storage/types.js";
import { PlatformError } from "./errors.js";
import { eventOwners } from "./events/inheritance.js";
import { isReleased } from "./revisions/policy.js";

const fileContainerTypeId = "41EF49EFD2ED4F6EAB04C047681F33AC";
const fileTypeId = "8052A558B9084D41B9F11805E464F443";

/** Suppressed business hooks do not replace native revision or vault services. */
export class VersionCopyPolicy {
    private readonly hasFileContainer: boolean;
    private readonly checked = new Set<string>();

    constructor(private readonly storage: HarnessStorage) {
        this.hasFileContainer =
            storage.getCatalogEntry("ItemType", fileContainerTypeId) !== undefined;
    }

    assertSupported(definition: ItemTypeDefinition, records: readonly StoredItem[]): void {
        if (definition.isVersionable && records.some((record) => isReleased(record))) {
            throw new PlatformError(
                "UnsupportedRevision",
                "Cloning released relationships requires a revision and lifecycle reset policy.",
            );
        }

        const id = definition.id.toLowerCase();

        if (this.checked.has(id)) {
            return;
        }

        if (
            id === fileTypeId.toLowerCase() ||
            definition.name.toLowerCase() === "file" ||
            (this.hasFileContainer &&
                eventOwners(this.storage, definition.id).has(fileContainerTypeId.toLowerCase()))
        ) {
            throw new PlatformError(
                "UnsupportedFileCopy",
                `Copying '${definition.name}' during versioning requires native file-container and vault services, which are unavailable.`,
                definition.source ? { source: definition.source } : undefined,
            );
        }

        this.checked.add(id);
    }
}
