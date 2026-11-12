import type { Database } from "bun:sqlite";

import { StorageError } from "./errors.js";

export const setCheckpoint = Symbol("setCheckpoint");
export const restoreCheckpoint = Symbol("restoreCheckpoint");
export const retainCheckpoint = Symbol("retainCheckpoint");

/** In-memory worlds retain an outer savepoint; ordinary requests commit inside that baseline. */
export class SqliteTransactions {
    private active = false;
    private checkpoint: Uint8Array | undefined;

    constructor(private readonly connection: () => Database) {}

    begin(): void {
        if (this.active || (!this.checkpoint && this.connection().inTransaction)) {
            throw new StorageError("TRANSACTION_STATE", "A storage transaction is already active.");
        }

        this.connection().run(this.checkpoint ? "SAVEPOINT _harness_request" : "BEGIN IMMEDIATE");
        this.active = true;
    }

    commit(): void {
        this.assertActive();
        this.connection().run(this.checkpoint ? "RELEASE _harness_request" : "COMMIT");
        this.active = false;
    }

    rollback(): void {
        this.assertActive();

        if (this.checkpoint) {
            this.connection().run("ROLLBACK TO _harness_request");
            this.connection().run("RELEASE _harness_request");
        } else {
            this.connection().run("ROLLBACK");
        }

        this.active = false;
    }

    mark(image: Uint8Array): void {
        this.assertIdle("checkpoint");

        if (this.checkpoint) {
            this.connection().run("RELEASE _harness_setup");
        }

        this.connection().run("SAVEPOINT _harness_setup");
        this.checkpoint = image;
    }

    restore(image: Uint8Array): boolean {
        this.assertIdle("reset");

        if (this.checkpoint !== image) {
            return false;
        }

        this.connection().run("ROLLBACK TO _harness_setup");

        return true;
    }

    owns(image: Uint8Array): boolean {
        return !this.active && this.checkpoint === image && this.connection().inTransaction;
    }

    adopt(image: Uint8Array): void {
        if (this.active || this.checkpoint || !this.connection().inTransaction) {
            throw new Error("A leased database must contain exactly its existing setup savepoint.");
        }

        this.checkpoint = image;
    }

    forget(): void {
        this.active = false;
        this.checkpoint = undefined;
    }

    flush(): void {
        this.assertIdle("snapshot");

        if (this.checkpoint) {
            // sqlite3_serialize reads the backing buffer of a deserialized database after commit.
            this.connection().run("RELEASE _harness_setup");
            this.checkpoint = undefined;
        }
    }

    assertIdle(operation: string): void {
        if (this.active || (!this.checkpoint && this.connection().inTransaction)) {
            throw new StorageError(
                "TRANSACTION_STATE",
                `Cannot ${operation} while a storage transaction is active.`,
            );
        }
    }

    private assertActive(): void {
        if (!this.active) {
            throw new StorageError("TRANSACTION_STATE", "No storage transaction is active.");
        }
    }
}
