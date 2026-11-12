import { assertDataTree, cloneFrozenData } from "../core/data.js";
import { workUnitsMax } from "../core/limits.js";
import { PlatformError } from "../platform/errors.js";
import { matches } from "../platform/query.js";
import type { HarnessStorage, StorageValue, StoredItem } from "../storage/types.js";

type Selector = Readonly<Record<string, StorageValue>>;

export interface StateReader {
    get(type: string, selector?: Selector): readonly StoredItem[];
    getOne(type: string, selector: Selector): StoredItem;
}

/** Read persisted columns without entering the action pipeline or deriving response properties. */
export function createStateReader(
    storage: HarnessStorage,
    assertReadable: () => void,
): StateReader {
    const get = (type: string, selector: Selector = {}): readonly StoredItem[] => {
        assertReadable();

        return readState(storage, type, selector);
    };

    return Object.freeze({
        get,

        getOne(type: string, selector: Selector): StoredItem {
            const records = get(type, selector);
            const record = records[0];

            if (records.length !== 1 || !record) {
                throw new PlatformError(
                    "ItemResolution",
                    `Expected one stored '${type}' record; found ${records.length}.`,
                );
            }

            return record;
        },
    });
}

function readState(
    storage: HarnessStorage,
    type: string,
    selector: Selector,
): readonly StoredItem[] {
    assertDataTree(selector, { allowArrays: false, allowUndefined: false });

    if (selector === null || typeof selector !== "object" || typeof type !== "string" || !type) {
        throw new TypeError("State reads require an ItemType and an object of stored values.");
    }

    const definition = storage.getItemType(type);

    if (!definition) {
        throw new PlatformError("MissingItemType", `ItemType '${type}' is not imported.`);
    }

    const predicates = Object.entries(selector).map(([name, value]) => {
        if (value !== null && typeof value !== "string" && typeof value !== "number") {
            throw new TypeError(`State selector '${name}' must be a stored scalar value.`);
        }

        const property = definition.properties.find((property) => property.name === name);

        if (
            name !== "id" &&
            (!property || property.dataType === "foreign" || property.isFederated)
        ) {
            throw new PlatformError(
                "InvalidStateSelector",
                `'${type}.${name}' is not a stored property.`,
            );
        }

        return { name, value };
    });
    const records = storage.listItems(definition.name);

    if (records.length * Math.max(1, predicates.length) > workUnitsMax) {
        throw new PlatformError("StateReadLimit", "The state query exceeds its work limit.");
    }

    const selected = records.filter((record) =>
        predicates.every((predicate) => matches(storage, definition, record, predicate)),
    );

    return cloneFrozenData(selected);
}
