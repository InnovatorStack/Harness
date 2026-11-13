import type { Item } from "../items/item.js";
import { relationshipKey } from "./graph-actions.js";

const requests = new WeakMap<Item, ReadonlyMap<string, string>>();

/** Keep generation copy identities private to the actual base-action request. */
export function rememberRequestCopies(request: Item, copies: ReadonlyMap<string, string>): void {
    if (copies.size > 0) {
        requests.set(request, copies);
    }
}

export function transferRequestCopies(source: Item, target: Item): void {
    const copies = requests.get(source);

    if (copies) {
        requests.set(target, copies);
    }
}

export function requestCopyId(request: Item, type: string, id: string): string {
    return requests.get(request)?.get(relationshipKey(type, id)) ?? id;
}
