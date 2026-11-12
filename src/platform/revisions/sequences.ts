import type { CatalogEntry, HarnessStorage, ItemTypeDefinition } from "../../storage/types.js";
import { PlatformError } from "../errors.js";

const sequenceCharactersMax = 1024 * 1024;
const sequenceValuesMax = 100_000;

export interface RevisionSequence {
    readonly entry: CatalogEntry;
    readonly values: readonly string[];
}

/** Resolve the exported sequence; the baseline supplies the native ItemType default. */
export class RevisionSequences {
    constructor(private readonly storage: HarnessStorage) {}

    resolve(definition: ItemTypeDefinition): RevisionSequence | undefined {
        const metadata = this.storage.getCatalogEntry("ItemType", definition.id);
        let id = metadata?.properties.revisions;

        if (id === undefined) {
            id = this.storage
                .getItemType("ItemType")
                ?.properties.find((property) => property.name === "revisions")?.defaultValue;
        }

        if (id === undefined || id === null || id === "") {
            return undefined;
        }

        const entry =
            typeof id === "string" ? this.storage.getCatalogEntry("Revision", id) : undefined;

        if (!entry) {
            throw new PlatformError(
                "MissingRevisionSequence",
                `Import the Revision referenced by '${definition.name}.revisions'.`,
                definition.source ? { source: definition.source } : undefined,
            );
        }

        const text = entry.properties.revision;

        if (typeof text !== "string" || text.length > sequenceCharactersMax) {
            throw new PlatformError(
                "InvalidRevisionSequence",
                `Revision '${entry.id}' needs a bounded whitespace-separated sequence.`,
                { source: entry.source },
            );
        }

        const values = text.trim().split(/\s+/u);

        if (
            !values[0] ||
            values.length > sequenceValuesMax ||
            new Set(values).size !== values.length
        ) {
            throw new PlatformError(
                "InvalidRevisionSequence",
                `Revision '${entry.id}' needs a nonempty sequence without duplicate values.`,
                { source: entry.source },
            );
        }

        return { entry, values };
    }
}
