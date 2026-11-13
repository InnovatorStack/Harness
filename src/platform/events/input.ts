import type { Item } from "../../items/item.js";

const documents = new WeakMap<Item, Item>();

/** A base action can hold an older request while callbacks receive its current document. */
export function bindRequestDocument(request: Item, document: Item): void {
    documents.set(request, document);
}

export function requestDocument(request: Item): Item {
    return documents.get(request) ?? request;
}
