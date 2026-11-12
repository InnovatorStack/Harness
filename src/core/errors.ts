export type RuntimeErrorCode =
    | "InvalidModule"
    | "DuplicateModule"
    | "MissingModule"
    | "ModuleCycle"
    | "DuplicateOperation"
    | "InvalidOperation"
    | "InvalidTransactionBoundary"
    | "UnknownOperation"
    | "AsyncOperationInSyncExecution"
    | "UnfinishedExecution"
    | "ExpiredExecutionContext"
    | "WorldBusy"
    | "RuntimeClosed";

export class RuntimeError extends Error {
    readonly code: RuntimeErrorCode;

    constructor(code: RuntimeErrorCode, message: string) {
        super(message);
        this.name = "RuntimeError";
        this.code = code;
    }
}

export function errorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    return String(error);
}
