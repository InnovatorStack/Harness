import { TokenKind, tokenize } from "../../queries/lexer.js";
import type { QueryOrder } from "../../queries/types.js";
import { compareValues } from "../../queries/values.js";
import type { HarnessStorage, ItemTypeDefinition, StoredItem } from "../../storage/types.js";
import { PlatformError } from "../errors.js";
import { fieldValue, resolveField } from "./fields.js";

export function orderBy(
    storage: HarnessStorage,
    definition: ItemTypeDefinition,
    expression: string | undefined,
): readonly QueryOrder[] {
    if (!expression) {
        return [];
    }

    const tokens = tokenize(expression);
    const orders: QueryOrder[] = [];
    let offset = 0;

    while (offset < tokens.length) {
        const names: string[] = [];

        while (true) {
            const token = tokens[offset++];

            if (!token || ![TokenKind.Word, TokenKind.Identifier].includes(token.kind)) {
                throw new PlatformError(
                    "UnsupportedOrder",
                    "ORDER BY requires property identifiers.",
                );
            }

            names.push(token.value);

            if (tokens[offset]?.value !== ".") {
                break;
            }

            offset += 1;
        }

        const direction =
            tokens[offset]?.kind === TokenKind.Word
                ? tokens[offset]?.value.toLowerCase()
                : undefined;

        if (direction === "asc" || direction === "desc") {
            offset += 1;
        }

        orders.push({
            field: resolveField(storage, definition, names),
            descending: direction === "desc",
        });

        if (offset < tokens.length && tokens[offset++]?.value !== ",") {
            throw new PlatformError("UnsupportedOrder", "Unsupported ORDER BY syntax.");
        }

        if (tokens.at(-1)?.value === ",") {
            throw new PlatformError("UnsupportedOrder", "ORDER BY cannot end with a comma.");
        }
    }

    return orders;
}

export function orderRows(
    storage: HarnessStorage,
    rows: readonly StoredItem[],
    orders: readonly QueryOrder[],
    spend: (units: number) => void,
): StoredItem[] {
    return [...rows].sort((left, right) => {
        for (const order of orders) {
            const a = fieldValue(storage, left, order.field);
            const b = fieldValue(storage, right, order.field);
            spend(String(a ?? "").length + String(b ?? "").length + 1);
            let difference = compareValues(order.field.kind, a, b);

            difference ??= nullOrder(a, b);

            if (difference !== 0) {
                return order.descending ? -difference : difference;
            }
        }

        spend(1);

        if (left.id === right.id) {
            return 0;
        }

        return left.id < right.id ? -1 : 1;
    });
}

function nullOrder(left: unknown, right: unknown): number {
    if (left === right) {
        return 0;
    }

    return left === null ? -1 : 1;
}
