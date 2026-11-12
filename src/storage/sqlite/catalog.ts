import type { CatalogEntry } from "../types.js";
import { decodeAttributes, decodeProperties, decodeSource } from "./metadata.js";

export interface CatalogRow {
    readonly id: string;
    readonly type: string;
    readonly properties: string;
    readonly attributes: string;
    readonly source: string;
}

const selectionsMax = 64;

/** Cache decoded rows privately; every reader still receives detached records. */
export class CatalogEntries {
    private readonly entries = new Map<string, { row: CatalogRow; entry: CatalogEntry }>();
    private readonly selections = new Map<string | undefined, readonly CatalogRow[]>();
    private epoch: number | undefined;

    select(
        type: string | undefined,
        epoch: number | undefined,
        read: () => readonly CatalogRow[],
    ): readonly CatalogEntry[] {
        this.refresh(epoch);
        let rows = this.selections.get(type);

        if (!rows) {
            rows = read();

            if (epoch !== undefined) {
                if (this.selections.size >= selectionsMax) {
                    this.selections.clear();
                }

                this.selections.set(type, rows);
            }
        }

        return rows.map((row) => this.read(row, epoch));
    }

    read(row: CatalogRow, epoch: number | undefined): CatalogEntry {
        this.refresh(epoch);
        const key = JSON.stringify([row.type, row.id]);
        let cached = this.entries.get(key);

        if (
            !cached ||
            cached.row.properties !== row.properties ||
            cached.row.attributes !== row.attributes ||
            cached.row.source !== row.source
        ) {
            cached = {
                row,
                entry: {
                    type: row.type,
                    id: row.id,
                    properties: decodeProperties(row.properties),
                    attributes: decodeAttributes(row.attributes),
                    source: decodeSource(row.source),
                },
            };

            if (epoch !== undefined) {
                this.entries.set(key, cached);
            }
        }

        return {
            ...cached.entry,
            properties: { ...cached.entry.properties },
            attributes: { ...cached.entry.attributes },
            source: { ...cached.entry.source },
        };
    }

    clear(): void {
        this.entries.clear();
        this.selections.clear();
    }

    private refresh(epoch: number | undefined): void {
        if (epoch === undefined || this.epoch !== epoch) {
            this.clear();
            this.epoch = epoch;
        }
    }
}
