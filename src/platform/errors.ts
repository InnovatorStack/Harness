import { capabilityForError } from "../compatibility/capabilities.js";
import type { CapabilityId } from "../compatibility/capabilities.js";
import type { SourceLocation } from "../diagnostics/source-location.js";
import type { Item } from "../items/item.js";

export class PlatformError extends Error {
    override readonly name = "PlatformError";
    readonly capability: CapabilityId | undefined;
    readonly source: SourceLocation | undefined;

    constructor(
        readonly code: string,
        message: string,
        options?: ErrorOptions & {
            readonly capability?: CapabilityId;
            readonly source?: SourceLocation;
        },
    ) {
        super(message, options);
        this.capability = options?.capability ?? capabilityForError(code);
        this.source = options?.source;
    }
}

export class ApplicationError extends Error {
    override readonly name = "ApplicationError";

    constructor(readonly item: Item) {
        super(item.getErrorString());
    }
}

export function requireSuccess(item: Item): Item {
    if (item.isError() && item.getErrorCode() !== "0") {
        throw new ApplicationError(item);
    }

    return item;
}
