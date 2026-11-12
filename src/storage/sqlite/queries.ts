import type { Database } from "bun:sqlite";

import type { Predicate } from "../../queries/types.js";
import type { HarnessStorage, ItemTypeDefinition, StorageValue, StoredItem } from "../types.js";
import { compilePredicate } from "./predicate.js";

const candidatesMax = 100_000;

/** SQLite narrows candidates; the shared evaluator owns the final, precision-preserving result. */
export class SqliteQueries {
    constructor(
        private readonly storage: HarnessStorage,
        private readonly connection: () => Database,
        private readonly decode: (
            definition: ItemTypeDefinition,
            row: Record<string, StorageValue>,
        ) => StoredItem,
    ) {}

    select(
        type: string,
        predicate: Predicate,
        spend: (units: number) => void,
    ): readonly StoredItem[] {
        const definition = this.storage.getItemType(type);

        if (!definition) {
            throw new TypeError(`Query ItemType '${type}' must be imported.`);
        }

        const compiled = compilePredicate(this.storage, definition, predicate);
        const statement = this.connection().query<Record<string, StorageValue>, StorageValue[]>(
            `${compiled.sql} LIMIT ${candidatesMax + 1}`,
        );
        // Conservative bounds can discard a branch with the last allocated placeholders.
        // SQLite's count includes numbered gaps and excludes unused trailing parameters.
        const rows = statement.all(...compiled.parameters.slice(0, statement.paramsCount));
        spend(rows.length);

        if (rows.length > candidatesMax) {
            throw new RangeError(
                "Query candidate limit exceeded. Narrow the selector before paging.",
            );
        }

        return rows.map((row) => this.decode(definition, row));
    }
}
