import type { SourceLocation } from "../../diagnostics/source-location.js";
import type { StorageValue } from "../../storage/types.js";
import { PlatformError } from "../errors.js";
import { ServerEventVersion } from "./types.js";

const collectionEvents = new Set([
    "onafteradd",
    "onafterupdate",
    "onafterversion",
    "onbeforecopy",
    "onaftercopy",
]);

export function eventVersion(
    name: string,
    value: StorageValue | undefined,
    source?: SourceLocation,
): ServerEventVersion {
    const declared = String(value ?? ServerEventVersion.Item);
    const version = Object.values(ServerEventVersion).find(
        (version: string) => version === declared,
    );

    if (version === ServerEventVersion.Item) {
        return ServerEventVersion.Item;
    }

    if (version === ServerEventVersion.Collection && collectionEvents.has(name.toLowerCase())) {
        return ServerEventVersion.Collection;
    }

    throw new PlatformError(
        "UnsupportedEventVersion",
        `Event '${name}' uses event context '${declared}', which is not supported for this event.`,
        source ? { source } : undefined,
    );
}
