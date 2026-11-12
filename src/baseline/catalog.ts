import { setOwn } from "../core/data.js";
import type { CatalogEntry, StorageValue } from "../storage/types.js";
import itemTypes from "./data/item-types.json";
import properties from "./data/properties.json";
import records from "./data/records.json";
import relationships from "./data/relationships.json";
import { baselineSource } from "./source.js";

interface BaselineRow {
    readonly id: string;
    readonly [name: string]: StorageValue | undefined;
}

function entries(type: string, rows: readonly BaselineRow[]): CatalogEntry[] {
    return rows.map((row) => {
        const values: Record<string, StorageValue> = {};

        for (const [name, value] of Object.entries(row)) {
            if (name !== "id" && value !== undefined) {
                setOwn(values, name, value);
            }
        }

        return Object.freeze({
            type,
            id: row.id,
            properties: Object.freeze(values),
            attributes: Object.freeze({}),
            source: Object.freeze(baselineSource(type, row.id)),
        });
    });
}

/** Curated platform defaults. Application packages remain separate inputs. */
export const baselineEntries: readonly CatalogEntry[] = Object.freeze([
    ...entries("ItemType", itemTypes),
    ...entries("Property", properties),
    ...entries("RelationshipType", relationships),
    ...Object.entries(records).flatMap(([type, rows]) => entries(type, rows)),
]);

export const baselineTypeNames: ReadonlySet<string> = new Set(itemTypes.map((type) => type.name));
