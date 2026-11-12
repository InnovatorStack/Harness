import { Item } from "../../items/item.js";
import type {
    HarnessStorage,
    ItemTypeDefinition,
    StorageValue,
    StoredItem,
} from "../../storage/types.js";
import { ApplicationError, PlatformError } from "../errors.js";
import { RevisionSequences } from "./sequences.js";

/** Generations share a revision until the released generation starts a new cycle. */
export class Revisions {
    private readonly sequences: RevisionSequences;

    constructor(storage: HarnessStorage) {
        this.sequences = new RevisionSequences(storage);
    }

    initial(
        definition: ItemTypeDefinition,
        values: Readonly<Record<string, StorageValue>>,
    ): Readonly<Record<string, StorageValue>> {
        if (!definition.isVersionable || values.major_rev !== undefined) {
            return {};
        }

        const first = this.sequences.resolve(definition)?.values[0];

        return first === undefined ? {} : { major_rev: first };
    }

    assertValue(definition: ItemTypeDefinition, value: StorageValue | undefined): void {
        if (!definition.isVersionable || value === undefined) {
            return;
        }

        const sequence = this.sequences.resolve(definition);

        if (sequence && !sequence.values.includes(String(value ?? ""))) {
            throw new ApplicationError(
                Item.error(
                    `Revision '${value}' is not in the sequence for '${definition.name}'.`,
                    "InvalidRevision",
                ),
            );
        }
    }

    next(definition: ItemTypeDefinition, previous: StoredItem): string {
        const sequence = this.sequences.resolve(definition);

        if (!sequence) {
            throw new PlatformError(
                "MissingRevisionSequence",
                `Revising released '${definition.name}' requires its exported Revision sequence.`,
                definition.source ? { source: definition.source } : undefined,
            );
        }

        const index = sequence.values.indexOf(String(previous.properties.major_rev ?? ""));

        if (index === -1) {
            throw new ApplicationError(
                Item.error(
                    `Current revision '${previous.properties.major_rev}' is not in the sequence for '${definition.name}'.`,
                    "InvalidRevision",
                ),
            );
        }

        const next = sequence.values[index + 1];

        if (next === undefined) {
            throw new ApplicationError(
                Item.error(
                    `Revision sequence exceeded for '${definition.name}'. Extend its exported Revision sequence.`,
                    "RevisionSequenceExceeded",
                ),
            );
        }

        return next;
    }
}

export function isReleased(record: StoredItem): boolean {
    return String(record.properties.is_released ?? "0") === "1";
}

export function removeRevisionProperties(
    request: Item,
    previous: StoredItem,
    current: StoredItem,
): void {
    const managed = [
        "major_rev",
        "permission_id",
        "state",
        "current_state",
        "is_released",
        "not_lockable",
        "release_date",
        "effective_date",
        "superseded_date",
    ];

    for (const name of managed) {
        const value = request.node.properties[name];

        if (value === undefined) {
            continue;
        }

        if (
            String(value ?? "") !== String(previous.properties[name] ?? "") &&
            String(value ?? "") !== String(current.properties[name] ?? "")
        ) {
            throw new PlatformError(
                "ReadOnlyProperty",
                `Revision property '${previous.type}.${name}' is managed by the new lifecycle cycle.`,
            );
        }

        delete request.node.properties[name];
    }
}
