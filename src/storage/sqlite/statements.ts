import type { Database, Statement } from "bun:sqlite";

import type { StorageValue } from "../types.js";

type ItemStatement = Statement<Record<string, StorageValue>, StorageValue[]>;

const statementsMax = 128;

/** Bounded, connection-owned SQL plans. These retain no item data or database copies. */
export class SqliteStatements {
    private readonly statements = new Map<string, ItemStatement>();

    constructor(private readonly connection: () => Database) {}

    query(sql: string): ItemStatement {
        const existing = this.statements.get(sql);

        if (existing) {
            this.statements.delete(sql);
            this.statements.set(sql, existing);

            return existing;
        }

        if (this.statements.size === statementsMax) {
            const oldest = this.statements.entries().next().value;

            if (!oldest) {
                throw new Error("A full statement cache must contain an eviction candidate.");
            }

            oldest[1].finalize();
            this.statements.delete(oldest[0]);
        }

        const statement = this.connection().prepare<Record<string, StorageValue>, StorageValue[]>(
            sql,
        );
        this.statements.set(sql, statement);

        return statement;
    }

    clear(): void {
        for (const statement of this.statements.values()) {
            statement.finalize();
        }

        this.statements.clear();
    }
}
