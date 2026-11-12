export type StorageErrorCode =
    | "STORAGE_CLOSED"
    | "INVALID_SCHEMA"
    | "INCOMPATIBLE_SCHEMA"
    | "UNKNOWN_ITEM_TYPE"
    | "INVALID_ITEM"
    | "ITEM_EXISTS"
    | "ITEM_NOT_FOUND"
    | "TRANSACTION_STATE"
    | "INVALID_SNAPSHOT"
    | "CORRUPT_STORAGE";

export class StorageError extends Error {
    override readonly name = "StorageError";

    constructor(
        readonly code: StorageErrorCode,
        message: string,
        options?: ErrorOptions,
    ) {
        super(message, options);
    }
}
