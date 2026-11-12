import type { SourceLocation } from "../diagnostics/source-location.js";

export type StorageValue = string | number | null;

export interface PropertyDefinition {
    readonly id?: string;
    readonly name: string;
    readonly dataType: string;
    readonly dataSource?: string;
    readonly foreignProperty?: string;
    readonly isFederated?: boolean;
    readonly isRequired?: boolean;
    readonly defaultValue?: StorageValue;
    readonly source?: SourceLocation;
}

export interface ItemTypeDefinition {
    readonly id: string;
    readonly name: string;
    readonly tableName?: string;
    readonly isRelationship?: boolean;
    readonly isVersionable?: boolean;
    readonly properties: readonly PropertyDefinition[];
    readonly source?: SourceLocation;
}

export interface StoredItem {
    readonly id: string;
    readonly type: string;
    readonly properties: Readonly<Record<string, StorageValue>>;
}

export interface CatalogEntry extends StoredItem {
    readonly attributes: Readonly<Record<string, string>>;
    readonly source: SourceLocation;
}

export interface PackageDocument {
    readonly path: string;
    readonly sha256: string;
    readonly xml: string;
}

export interface TransactionBoundary {
    begin(): void;
    commit(): void;
    rollback(): void;
}

export interface HarnessStorage {
    readonly transactions: TransactionBoundary;
    defineItemType(definition: ItemTypeDefinition): void;
    getItemType(name: string): ItemTypeDefinition | undefined;
    listItemTypes(): readonly ItemTypeDefinition[];
    insertItem(item: StoredItem): void;
    updateItem(type: string, id: string, properties: Readonly<Record<string, StorageValue>>): void;
    getItem(type: string, id: string): StoredItem | undefined;
    listItems(type: string): readonly StoredItem[];
    deleteItem(type: string, id: string): void;
    putCatalogEntry(entry: CatalogEntry): void;
    getCatalogEntry(type: string, id: string): CatalogEntry | undefined;
    listCatalogEntries(type?: string): readonly CatalogEntry[];
    deleteCatalogEntry(type: string, id: string): void;
    putDocument(document: PackageDocument): void;
    listDocuments(): readonly PackageDocument[];
    snapshot(): Uint8Array;
    restore(snapshot: Uint8Array): void;
    close(): void;
}
