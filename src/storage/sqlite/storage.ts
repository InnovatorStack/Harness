import { Database } from "bun:sqlite";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { assertDataTree, getOwn } from "../../core/data.js";
import { setupBytesMax } from "../../core/limits.js";
import { selectQuery } from "../../queries/types.js";
import type { Predicate } from "../../queries/types.js";
import { selectDocument } from "../documents.js";
import { changeMetadata, metadataEpoch, trackMetadata } from "../metadata-epoch.js";
import { packageTransaction } from "../package-transaction.js";
import type {
    CatalogEntry,
    HarnessStorage,
    ItemTypeDefinition,
    PackageDocument,
    StorageValue,
    StoredItem,
    TransactionBoundary,
} from "../types.js";
import { CatalogEntries } from "./catalog.js";
import type { CatalogRow } from "./catalog.js";
import { takeConnection, retainConnection } from "./connections.js";
import { StorageError } from "./errors.js";
import { decodeDefinition, decodePresentProperties } from "./metadata.js";
import { SqliteQueries } from "./queries.js";
import {
    assertCompatible,
    columnsFor,
    columnFor,
    normalizeValue,
    quoteIdentifier,
    tableName,
    validateDefinition,
} from "./schema.js";
import { SqliteStatements } from "./statements.js";
import {
    SqliteTransactions,
    setCheckpoint,
    restoreCheckpoint,
    retainCheckpoint,
} from "./transactions.js";

interface DefinitionRow {
    readonly name: string;
    readonly definition: string;
}

const schemaVersion = 1;
const applicationId = 0x49_48_4e_53;

function openDatabase(filename: string): Database {
    const database = new Database(filename, { create: true, strict: true });

    try {
        database.run("PRAGMA foreign_keys = ON");
        database.run("PRAGMA journal_mode = DELETE");
    } catch (error) {
        database.close();

        throw error;
    }

    return database;
}

export class SqliteStorage implements HarnessStorage {
    private readonly catalog = new CatalogEntries();
    private readonly boundary = new SqliteTransactions(() => this.database);
    private readonly statements = new SqliteStatements(() => this.database);
    private readonly selections = new SqliteQueries(
        this,
        () => this.database,
        (definition, row) => this.decodeItem(definition, row),
    );

    [selectQuery](
        type: string,
        predicate: Predicate,
        spend: (units: number) => void,
    ): readonly StoredItem[] {
        return this.selections.select(type, predicate, spend);
    }

    readonly transactions: TransactionBoundary = Object.freeze({
        begin: () => {
            this.boundary.begin();
            this.transactionMetadata = metadataEpoch(this);

            if (this.transactionMetadata === undefined) {
                this.definitions.clear();
            }
        },

        commit: () => {
            this.boundary.commit();
        },

        rollback: () => {
            this.boundary.rollback();

            if (
                this.transactionMetadata === undefined ||
                this.transactionMetadata !== metadataEpoch(this)
            ) {
                this.clearStatements();
            }

            this.definitions.clear();
            changeMetadata(this);
        },
    });

    private connection: Database;
    private closed = false;
    private packageWriteActive = false;
    private transactionMetadata: number | undefined;
    private readonly filename: string;
    private reusableImage: Uint8Array | undefined;
    private definitionList:
        | { readonly epoch: number; readonly values: readonly ItemTypeDefinition[] }
        | undefined;
    private readonly definitions = new Map<
        string,
        { readonly encoded: string; readonly value: ItemTypeDefinition }
    >();

    constructor(filename = ":memory:") {
        this.filename = filename === ":memory:" ? filename : resolve(filename);
        this.connection = openDatabase(this.filename);

        try {
            this.initialize();

            if (this.filename === ":memory:") {
                trackMetadata(this);
            }
        } catch (error) {
            this.connection.close();

            throw error;
        }
    }

    defineItemType(definition: ItemTypeDefinition): void {
        assertStorageData(definition, "INVALID_SCHEMA");
        validateDefinition(definition);
        const database = this.database;

        if (!database.inTransaction) {
            this.definitions.clear();
        }

        this.writeAtomically(() => {
            const previous = this.getItemType(definition.name);

            if (
                previous &&
                this.definitions.get(definition.name.toLowerCase())?.encoded ===
                    JSON.stringify(definition)
            ) {
                return;
            }

            if (previous) {
                assertCompatible(previous, definition);
            }

            this.assertUniqueTypeId(definition);

            this.defineTable(definition, previous);

            database
                .query(
                    "INSERT INTO _harness_item_types (id, name, definition) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET id = excluded.id, definition = excluded.definition",
                )
                .run(definition.id, definition.name, JSON.stringify(definition));
            this.definitions.delete(definition.name.toLowerCase());
            changeMetadata(this);
        });
    }

    getItemType(name: string): ItemTypeDefinition | undefined {
        // An active transaction has one metadata view; schema writes invalidate their entry.
        // Outside it, read SQLite so other connections and direct storage callers remain visible.
        const cached = this.definitions.get(name.toLowerCase());

        if ((this.database.inTransaction || metadataEpoch(this) !== undefined) && cached) {
            return cached.value;
        }

        const row = this.database
            .query<DefinitionRow, [string]>(
                "SELECT name, definition FROM _harness_item_types WHERE name = ? COLLATE NOCASE",
            )
            .get(name);

        if (row) {
            return this.readDefinition(row);
        }

        return undefined;
    }

    listItemTypes(): readonly ItemTypeDefinition[] {
        const database = this.database;
        const epoch = metadataEpoch(this);

        if (epoch !== undefined && this.definitionList?.epoch === epoch) {
            return this.definitionList.values;
        }

        const values = Object.freeze(
            database
                .query<DefinitionRow, []>(
                    "SELECT name, definition FROM _harness_item_types ORDER BY name COLLATE BINARY",
                )
                .all()
                .map((row) => this.readDefinition(row)),
        );

        if (epoch !== undefined) {
            this.definitionList = { epoch, values };
        }

        return values;
    }

    insertItem(item: StoredItem): void {
        const definition = this.requireItemType(item.type);
        this.validateId(item.id);
        const properties = this.normalizeProperties(definition, item.properties);

        this.writeAtomically(() => {
            const names = ["id", ...Object.keys(properties)];
            const values: StorageValue[] = [item.id, ...Object.values(properties)];
            const result = this.statements
                .query(
                    `INSERT INTO ${quoteIdentifier(tableName(definition))} ` +
                        `(${names.map(quoteIdentifier).join(", ")}) ` +
                        `VALUES (${names.map(() => "?").join(", ")}) ` +
                        "ON CONFLICT(id) DO NOTHING",
                )
                .run(...values);

            if (result.changes === 0) {
                throw new StorageError(
                    "ITEM_EXISTS",
                    `${definition.name} item ${item.id} already exists.`,
                );
            }

            this.writePresence(definition.name, item.id, Object.keys(properties));
        });
    }

    updateItem(type: string, id: string, values: Readonly<Record<string, StorageValue>>): void {
        const definition = this.requireItemType(type);
        const properties = this.normalizeProperties(definition, values);

        this.writeAtomically(() => {
            const existing = this.getItem(definition.name, id);

            if (!existing) {
                throw new StorageError(
                    "ITEM_NOT_FOUND",
                    `${definition.name} item ${id} does not exist.`,
                );
            }

            const entries = Object.entries(properties);

            if (!entries.length) {
                return;
            }

            this.statements
                .query(
                    `UPDATE ${quoteIdentifier(tableName(definition))} SET ${entries
                        .map(([name]) => `${quoteIdentifier(name)} = ?`)
                        .join(", ")} WHERE id = ?`,
                )
                .run(...entries.map(([, value]) => value), id);
            this.writePresence(definition.name, existing.id, [
                ...new Set([...Object.keys(existing.properties), ...Object.keys(properties)]),
            ]);
        });
    }

    getItem(type: string, id: string): StoredItem | undefined {
        const definition = this.requireItemType(type);
        const row = this.statements
            .query(
                `SELECT r.*, p.properties AS _harness_presence FROM ${quoteIdentifier(tableName(definition))} AS r ` +
                    "LEFT JOIN _harness_presence AS p ON p.type = ? COLLATE NOCASE AND p.id = r.id COLLATE NOCASE WHERE r.id = ?",
            )
            .get(definition.name, id);

        if (row) {
            return this.decodeItem(definition, row);
        }

        return undefined;
    }

    listItems(type: string): readonly StoredItem[] {
        const definition = this.requireItemType(type);

        return this.statements
            .query(
                `SELECT r.*, p.properties AS _harness_presence FROM ${quoteIdentifier(tableName(definition))} AS r ` +
                    "LEFT JOIN _harness_presence AS p ON p.type = ? COLLATE NOCASE AND p.id = r.id COLLATE NOCASE ORDER BY r.id COLLATE BINARY",
            )
            .all(definition.name)
            .map((row) => this.decodeItem(definition, row));
    }

    deleteItem(type: string, id: string): void {
        const definition = this.requireItemType(type);
        const database = this.database;
        this.writeAtomically(() => {
            if (!this.getItem(type, id)) {
                throw new StorageError(
                    "ITEM_NOT_FOUND",
                    `${definition.name} item ${id} does not exist.`,
                );
            }

            this.statements
                .query(`DELETE FROM ${quoteIdentifier(tableName(definition))} WHERE id = ?`)
                .run(id);
            database
                .query(
                    "DELETE FROM _harness_presence WHERE type = ? COLLATE NOCASE AND id = ? COLLATE NOCASE",
                )
                .run(definition.name, id);
        });
    }

    putCatalogEntry(entry: CatalogEntry): void {
        changeMetadata(this);
        assertStorageData(entry, "INVALID_ITEM");
        this.validateId(entry.id);
        this.database
            .query(
                "INSERT INTO _harness_catalog (type, id, properties, attributes, source) VALUES (?, ?, ?, ?, ?) ON CONFLICT(type, id) DO UPDATE SET properties = excluded.properties, attributes = excluded.attributes, source = excluded.source",
            )
            .run(
                entry.type,
                entry.id,
                JSON.stringify(entry.properties),
                JSON.stringify(entry.attributes),
                JSON.stringify(entry.source),
            );
    }

    getCatalogEntry(type: string, id: string): CatalogEntry | undefined {
        const row = this.database
            .query<CatalogRow, [string, string]>(
                "SELECT * FROM _harness_catalog WHERE type = ? COLLATE NOCASE AND id = ? COLLATE NOCASE",
            )
            .get(type, id);

        if (row) {
            return this.catalog.read(row, metadataEpoch(this));
        }

        return undefined;
    }

    listCatalogEntries(type?: string): readonly CatalogEntry[] {
        const database = this.database;

        return this.catalog.select(type, metadataEpoch(this), () =>
            type === undefined
                ? database
                      .query<CatalogRow, []>(
                          "SELECT * FROM _harness_catalog ORDER BY type COLLATE BINARY, id COLLATE BINARY",
                      )
                      .all()
                : database
                      .query<CatalogRow, [string]>(
                          "SELECT * FROM _harness_catalog WHERE type = ? COLLATE NOCASE ORDER BY id COLLATE BINARY",
                      )
                      .all(type),
        );
    }

    deleteCatalogEntry(type: string, id: string): void {
        changeMetadata(this);
        this.database
            .query(
                "DELETE FROM _harness_catalog WHERE type = ? COLLATE NOCASE AND id = ? COLLATE NOCASE",
            )
            .run(type, id);
    }

    putDocument(document: PackageDocument): void {
        changeMetadata(this);
        this.database
            .query(
                "INSERT INTO _harness_documents (path, sha256, xml) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET sha256 = excluded.sha256, xml = excluded.xml",
            )
            .run(document.path, document.sha256, document.xml);
    }

    listDocuments(): readonly PackageDocument[] {
        return this.database
            .query<PackageDocument, []>(
                "SELECT path, sha256, xml FROM _harness_documents ORDER BY path COLLATE BINARY",
            )
            .all();
    }

    [selectDocument](path: string): PackageDocument | undefined {
        return (
            this.database
                .query<PackageDocument, [string]>(
                    "SELECT path, sha256, xml FROM _harness_documents WHERE path = ?",
                )
                .get(path) ?? undefined
        );
    }

    snapshot(): Uint8Array {
        this.requireNoTransaction("snapshot");
        this.boundary.flush();
        const pages = this.database
            .query<{ page_count: number }, []>("PRAGMA page_count")
            .get()?.page_count;
        const pageSize = this.database
            .query<{ page_size: number }, []>("PRAGMA page_size")
            .get()?.page_size;

        if (pages === undefined || pageSize === undefined || pages * pageSize > setupBytesMax) {
            throw new StorageError(
                "INVALID_SNAPSHOT",
                "The database exceeds its snapshot byte limit.",
            );
        }

        return new Uint8Array(this.database.serialize());
    }

    [setCheckpoint](image: Uint8Array): void {
        if (this.filename === ":memory:") {
            this.boundary.mark(image);
        }
    }

    [restoreCheckpoint](image: Uint8Array): boolean {
        if (this.filename !== ":memory:") {
            return false;
        }

        this.statements.clear();

        if (!this.boundary.restore(image)) {
            return false;
        }

        this.definitions.clear();
        this.definitionList = undefined;
        this.catalog.clear();
        changeMetadata(this);

        return true;
    }

    [retainCheckpoint](image: Uint8Array): void {
        if (this.filename === ":memory:" && this.boundary.owns(image)) {
            this.reusableImage = image;
        }
    }

    restore(snapshot: Uint8Array): void {
        this.requireNoTransaction("restore");
        changeMetadata(this);

        if (snapshot.byteLength > setupBytesMax) {
            throw new StorageError("INVALID_SNAPSHOT", "The snapshot exceeds its byte limit.");
        }

        this.definitions.clear();
        const leased = this.filename === ":memory:" ? takeConnection(snapshot) : undefined;
        let restored: Database | undefined;

        try {
            restored =
                leased ??
                Database.deserialize(new Uint8Array(snapshot), {
                    strict: true,
                });

            if (!leased) {
                this.validateSnapshot(restored);
            }
        } catch (error) {
            restored?.close();

            throw new StorageError(
                "INVALID_SNAPSHOT",
                "Cannot restore an invalid InnovatorHarness database snapshot.",
                { cause: error },
            );
        }

        if (this.filename === ":memory:") {
            this.statements.clear();
            this.connection.close();
            this.connection = restored;
            this.boundary.forget();

            if (leased) {
                this.boundary.adopt(snapshot);
            }

            this.connection.run("PRAGMA foreign_keys = ON");

            return;
        }

        const temporaryPath = `${this.filename}.${crypto.randomUUID()}.restore`;

        try {
            writeFileSync(temporaryPath, restored.serialize(), { flag: "wx" });
            this.statements.clear();
            this.connection.close();

            try {
                renameSync(temporaryPath, this.filename);
            } finally {
                this.connection = openDatabase(this.filename);
            }
        } finally {
            restored.close();
            rmSync(temporaryPath, { force: true });
        }
    }

    close(): void {
        if (this.closed) {
            return;
        }

        const failures: unknown[] = [];
        let retained = false;

        try {
            retained = this.retainCleanConnection();
        } catch (error) {
            failures.push(error);
        }

        this.closed = true;
        this.definitions.clear();
        this.catalog.clear();
        this.definitionList = undefined;

        if (retained) {
            return;
        }

        try {
            if (this.connection.inTransaction) {
                this.connection.run("ROLLBACK");
            }
        } catch (error) {
            failures.push(error);
        }

        try {
            this.statements.clear();
            this.connection.close();
        } catch (error) {
            failures.push(error);
        }

        if (failures.length > 0) {
            throw new AggregateError(failures, "Storage cleanup failed.");
        }
    }

    [packageTransaction]<Result>(write: () => Result): Result {
        if (this.packageWriteActive) {
            throw new StorageError("TRANSACTION_STATE", "Package write scopes cannot overlap.");
        }

        try {
            return this.database.transaction(() => {
                this.packageWriteActive = true;

                try {
                    return write();
                } finally {
                    this.packageWriteActive = false;
                }
            })();
        } catch (error) {
            // A rolled-back ALTER can leave cached result columns describing the temporary schema.
            this.clearStatements();
            this.definitions.clear();
            this.definitionList = undefined;
            this.catalog.clear();
            changeMetadata(this);

            throw error;
        }
    }

    private writeAtomically<Result>(write: () => Result): Result {
        if (this.packageWriteActive) {
            return write();
        }

        return this.database.transaction(write)();
    }

    private clearStatements(): void {
        this.statements.clear();
        this.connection.clearQueryCache();
    }

    private retainCleanConnection(): boolean {
        const image = this.reusableImage;
        this.reusableImage = undefined;

        if (!image || !this.boundary.owns(image)) {
            return false;
        }

        this.statements.clear();
        this.boundary.restore(image);

        if (!retainConnection(image, this.connection)) {
            return false;
        }

        this.boundary.forget();

        return true;
    }

    private defineTable(
        definition: ItemTypeDefinition,
        previous: ItemTypeDefinition | undefined,
    ): void {
        const database = this.database;
        const physicalName = tableName(definition);
        const columns = columnsFor(definition);

        if (previous) {
            const previousNames = new Set(
                columnsFor(previous).map((column) => column.name.toLowerCase()),
            );

            for (const column of columns) {
                if (!previousNames.has(column.name.toLowerCase())) {
                    database.run(
                        `ALTER TABLE ${quoteIdentifier(physicalName)} ` +
                            `ADD COLUMN ${quoteIdentifier(column.name)} ${column.declaration}`,
                    );
                }
            }
        } else {
            const existing = database
                .query<{ name: string }, [string]>(
                    "SELECT name FROM sqlite_schema WHERE name = ? COLLATE NOCASE",
                )
                .get(physicalName);

            if (existing) {
                throw new StorageError(
                    "INVALID_SCHEMA",
                    `Table name ${physicalName} is already in use.`,
                );
            }

            const declarations = columns.map((column) => {
                const primaryKey =
                    column.name === "id" ? " NOT NULL PRIMARY KEY COLLATE NOCASE" : "";

                return `${quoteIdentifier(column.name)} ${column.declaration}${primaryKey}`;
            });
            database.run(
                `CREATE TABLE ${quoteIdentifier(physicalName)} (${declarations.join(", ")}) STRICT`,
            );
        }
    }

    private assertUniqueTypeId(definition: ItemTypeDefinition): void {
        const database = this.database;
        const duplicate = database
            .query<{ name: string }, [string]>(
                "SELECT name FROM _harness_item_types WHERE id = ? COLLATE NOCASE",
            )
            .get(definition.id);

        if (duplicate && duplicate.name !== definition.name) {
            throw new StorageError(
                "INVALID_SCHEMA",
                `ItemType id ${definition.id} already belongs to ${duplicate.name}.`,
            );
        }
    }

    private get database(): Database {
        if (this.closed) {
            throw new StorageError("STORAGE_CLOSED", "SQLite storage is closed.");
        }

        return this.connection;
    }

    private initialize(): void {
        const version = this.database
            .query<{ user_version: number }, []>("PRAGMA user_version")
            .get()?.user_version;
        const identity = this.database
            .query<{ application_id: number }, []>("PRAGMA application_id")
            .get()?.application_id;
        const hasTables =
            this.database
                .query<{ name: string }, []>(
                    "SELECT name FROM sqlite_schema WHERE type = 'table' LIMIT 1",
                )
                .get() !== null;

        if (
            (identity !== 0 && identity !== applicationId) ||
            (identity !== applicationId && hasTables)
        ) {
            throw new StorageError(
                "INCOMPATIBLE_SCHEMA",
                "Database is not an InnovatorHarness storage database.",
            );
        }

        if (version !== 0 && version !== schemaVersion) {
            throw new StorageError(
                "INCOMPATIBLE_SCHEMA",
                `Unsupported database schema version ${version}; expected ${schemaVersion}.`,
            );
        }

        this.database.transaction(() => {
            this.database.run(`
        CREATE TABLE IF NOT EXISTS _harness_item_types (
          id TEXT NOT NULL PRIMARY KEY COLLATE NOCASE,
          name TEXT NOT NULL UNIQUE COLLATE NOCASE,
          definition TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS _harness_catalog (
          type TEXT NOT NULL COLLATE NOCASE,
          id TEXT NOT NULL COLLATE NOCASE,
          properties TEXT NOT NULL,
          attributes TEXT NOT NULL,
          source TEXT NOT NULL,
          PRIMARY KEY (type, id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS _harness_documents (
          path TEXT NOT NULL PRIMARY KEY,
          sha256 TEXT NOT NULL,
          xml TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS _harness_presence (
          type TEXT NOT NULL COLLATE NOCASE,
          id TEXT NOT NULL COLLATE NOCASE,
          properties TEXT NOT NULL,
          PRIMARY KEY (type, id)
        ) STRICT;
        PRAGMA user_version = ${schemaVersion};
        PRAGMA application_id = ${applicationId};
      `);
        })();
    }

    private validateSnapshot(database: Database): void {
        const version = database
            .query<{ user_version: number }, []>("PRAGMA user_version")
            .get()?.user_version;
        const identity = database
            .query<{ application_id: number }, []>("PRAGMA application_id")
            .get()?.application_id;
        const check = database
            .query<{ quick_check: string }, []>("PRAGMA quick_check")
            .get()?.quick_check;

        if (version !== schemaVersion || identity !== applicationId || check !== "ok") {
            throw new StorageError(
                "INVALID_SNAPSHOT",
                "Snapshot has an incompatible schema or failed SQLite integrity checking.",
            );
        }

        database.query("SELECT id, name, definition FROM _harness_item_types LIMIT 0").all();
        database
            .query("SELECT type, id, properties, attributes, source FROM _harness_catalog LIMIT 0")
            .all();
        database.query("SELECT path, sha256, xml FROM _harness_documents LIMIT 0").all();
        database.query("SELECT type, id, properties FROM _harness_presence LIMIT 0").all();
    }

    private requireNoTransaction(operation: string): void {
        this.boundary.assertIdle(operation);
    }

    private requireItemType(name: string): ItemTypeDefinition {
        const definition = this.getItemType(name);

        if (!definition) {
            throw new StorageError(
                "UNKNOWN_ITEM_TYPE",
                `ItemType ${name} is not defined. Load its package before accessing its items.`,
            );
        }

        return definition;
    }

    private readDefinition(row: DefinitionRow): ItemTypeDefinition {
        // Lists and standalone lookups compare the stored representation before reuse.
        const key = row.name.toLowerCase();
        const cached = this.definitions.get(key);

        if (cached?.encoded === row.definition) {
            return cached.value;
        }

        const definition = decodeDefinition(row.definition);

        for (const property of definition.properties) {
            if (property.source) {
                Object.freeze(property.source);
            }

            Object.freeze(property);
        }

        if (definition.source) {
            Object.freeze(definition.source);
        }

        Object.freeze(definition.properties);
        Object.freeze(definition);
        this.definitions.set(key, { encoded: row.definition, value: definition });

        return definition;
    }

    private validateId(id: string): void {
        if (typeof id !== "string" || !id.trim()) {
            throw new StorageError("INVALID_ITEM", "Item id must be a non-empty string.");
        }
    }

    private normalizeProperties(
        definition: ItemTypeDefinition,
        properties: Readonly<Record<string, StorageValue>>,
    ): Record<string, StorageValue> {
        assertStorageData(properties, "INVALID_ITEM");
        const result: Record<string, StorageValue> = {};

        for (const [name, value] of Object.entries(properties)) {
            const column = columnFor(definition, name);

            if (!column || name === "id") {
                throw new StorageError(
                    "INVALID_ITEM",
                    `Unknown or immutable property ${definition.name}.${name}.`,
                );
            }

            Object.defineProperty(result, name, {
                value: normalizeValue(column, value),
                enumerable: true,
                configurable: true,
                writable: true,
            });
        }

        return result;
    }

    private writePresence(type: string, id: string, properties: readonly string[]): void {
        this.database
            .query(
                "INSERT INTO _harness_presence (type, id, properties) VALUES (?, ?, ?) ON CONFLICT(type, id) DO UPDATE SET properties = excluded.properties",
            )
            .run(type, id, JSON.stringify(properties));
    }

    private decodeItem(
        definition: ItemTypeDefinition,
        row: Record<string, StorageValue>,
    ): StoredItem {
        const id = row.id;

        if (typeof id !== "string") {
            throw new StorageError(
                "CORRUPT_STORAGE",
                `Invalid id stored in table ${tableName(definition)}.`,
            );
        }

        const presence = getOwn(row, "_harness_presence");

        if (typeof presence !== "string") {
            throw new StorageError(
                "CORRUPT_STORAGE",
                `Missing property presence metadata for ${definition.name} ${id}.`,
            );
        }

        const properties: Record<string, StorageValue> = {};

        for (const name of decodePresentProperties(presence)) {
            const value = getOwn(row, name);

            if (value === undefined || name === "_harness_presence") {
                throw new StorageError(
                    "CORRUPT_STORAGE",
                    `Missing column ${definition.name}.${name}.`,
                );
            }

            Object.defineProperty(properties, name, {
                value,
                enumerable: true,
                configurable: true,
                writable: true,
            });
        }

        return { type: definition.name, id, properties };
    }
}

function assertStorageData(value: unknown, code: "INVALID_SCHEMA" | "INVALID_ITEM"): void {
    try {
        assertDataTree(value);
    } catch (error) {
        if (!(error instanceof TypeError)) {
            throw error;
        }

        throw new StorageError(code, `Invalid storage data: ${error.message}`, { cause: error });
    }
}
