import { dateKey } from "../../queries/date.js";
import type { StoredItem } from "../../storage/types.js";
import { PlatformError } from "../errors.js";

/** Membership dates use the same UTC and fractional precision rules as native AML date queries. */
export function effective(record: StoredItem, now: Date): boolean {
    const start = instant(record.properties.from_date);
    const end = instant(record.properties.end_date);
    const current = BigInt(dateKey(now.toISOString()));

    return (start === undefined || start <= current) && (end === undefined || current <= end);
}

function instant(value: StoredItem["properties"][string] | undefined): bigint | undefined {
    if (value === undefined || value === null || value === "") {
        return undefined;
    }

    if (typeof value !== "string") {
        throw new PlatformError("InvalidPermissionDate", "Permission dates must be date text.");
    }

    try {
        return BigInt(dateKey(value));
    } catch (cause) {
        throw new PlatformError("InvalidPermissionDate", `Invalid permission date '${value}'.`, {
            cause,
        });
    }
}
