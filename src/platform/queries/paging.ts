import type { ItemMessage, ItemNode } from "../../items/item.js";
import type { StoredItem } from "../../storage/types.js";
import { PlatformError } from "../errors.js";

export interface PageSelection {
    readonly records: readonly StoredItem[];
    readonly relationships?: ReadonlyMap<string, readonly ItemNode[]>;
    readonly messages?: readonly ItemMessage[];
}

export function pageRows(request: ItemNode, records: readonly StoredItem[]): PageSelection {
    const size = integer(request.attributes.pagesize, "pagesize");
    const page = integer(request.attributes.page, "page") ?? 1;
    const maximum = integer(request.attributes.maxRecords, "maxRecords");

    if (
        (request.attributes.action ?? "get") !== "get" &&
        (size !== undefined || maximum !== undefined || request.attributes.page !== undefined)
    ) {
        throw new PlatformError(
            "UnsupportedAttribute",
            "Paging attributes are only supported on get requests.",
        );
    }

    if (size === undefined && page !== 1) {
        throw new PlatformError("InvalidPaging", "page requires pagesize.");
    }

    const bounded = maximum === undefined ? records : records.slice(0, maximum);

    if (size === undefined) {
        return { records: bounded };
    }

    const offset = (page - 1) * size;

    if (!Number.isSafeInteger(offset)) {
        throw new PlatformError(
            "InvalidPaging",
            "The page offset exceeds the supported integer range.",
        );
    }

    return {
        records: bounded.slice(offset, offset + size),
        messages: [
            { name: "itemmax", value: String(bounded.length) },
            { name: "pagemax", value: String(Math.ceil(bounded.length / size)) },
        ],
    };
}

function integer(value: string | undefined, name: string): number | undefined {
    if (value === undefined || value === "") {
        return undefined;
    }

    const number = Number(value);

    if (!/^\d+$/u.test(value) || !Number.isSafeInteger(number) || number < 1) {
        throw new PlatformError("InvalidPaging", `${name} must be a positive safe integer.`);
    }

    return number;
}
