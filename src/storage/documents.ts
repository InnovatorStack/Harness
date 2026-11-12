import type { HarnessStorage, PackageDocument } from "./types.js";

export const selectDocument = Symbol("selectDocument");

interface DocumentLookup {
    [selectDocument](path: string): PackageDocument | undefined;
}

function hasDocumentLookup(storage: HarnessStorage): storage is HarnessStorage & DocumentLookup {
    return selectDocument in storage && typeof storage[selectDocument] === "function";
}

/** Native adapters can select one source document without loading the complete package export. */
export function findDocument(storage: HarnessStorage, path: string): PackageDocument | undefined {
    if (hasDocumentLookup(storage)) {
        return storage[selectDocument](path);
    }

    return storage.listDocuments().find((document) => document.path === path);
}
