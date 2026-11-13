import { Item } from "../../items/item.js";
import type { ItemNode } from "../../items/item.js";
import { itemNodes, itemOrigin } from "../../items/origins.js";
import { PlatformError } from "../../platform/errors.js";
import { bindRequestDocument, requestDocument } from "../../platform/events/input.js";
import { documentInput, documentRoot, readDocument, rememberDocument } from "./documents.js";
import type { DocumentInput } from "./documents.js";
import type { ManagedOrigins, OriginFrame } from "./origins.js";
import { requestDifference } from "./request-change.js";
import type { RequestChange } from "./request-change.js";

export interface BaseInputChange {
    readonly request?: RequestChange;
    readonly origins: OriginFrame;
    readonly document?: DocumentInput;
    readonly documentChange?: RequestChange;
    readonly documentOrigins?: OriginFrame;
    readonly retainedDocument?: RequestChange;
    readonly retainedOrigins?: OriginFrame;
}

export function decodeBaseInput(
    payload: Record<string, unknown>,
    origins: ManagedOrigins,
): BaseInput {
    if (typeof payload.xml !== "string") {
        throw new PlatformError("InvalidProtocol", "A base action requires request XML.");
    }

    if (payload.document !== undefined && typeof payload.document !== "boolean") {
        throw new PlatformError("InvalidProtocol", "The base document marker must be boolean.");
    }

    const item = new Item(readDocument(payload.xml));

    if (item.getItemCount() !== 1 || item.isError() || item.payload.result !== undefined) {
        throw new PlatformError(
            "InvalidServerEventContext",
            "A base action requires one request Item.",
        );
    }

    origins.bind(item.payload, payload.origins);

    if (payload.document === true) {
        rememberDocument(item, payload.xml);
    }

    bindCurrentDocument(item, payload, origins);

    return new BaseInput(item);
}

function bindCurrentDocument(
    request: Item,
    payload: Record<string, unknown>,
    origins: ManagedOrigins,
): void {
    if (payload.currentDocument === undefined || payload.currentDocument === null) {
        if (payload.currentOrigins !== undefined && payload.currentOrigins !== null) {
            throw new PlatformError("InvalidProtocol", "Current document origins have no XML.");
        }

        return;
    }

    if (typeof payload.currentDocument !== "string") {
        throw new PlatformError("InvalidProtocol", "Current base document XML must be text.");
    }

    const document = new Item(readDocument(payload.currentDocument));
    origins.bind(document.payload, payload.currentOrigins);
    const retained = new Set([...itemNodes(request.payload)].map(itemOrigin));

    for (const node of itemNodes(document.payload)) {
        if (retained.has(itemOrigin(node))) {
            throw new PlatformError(
                "InvalidProtocol",
                "Detached base input and current document cannot share pending Item origins.",
            );
        }
    }

    rememberDocument(document, payload.currentDocument);
    bindRequestDocument(request, document);
}

/** Keep the default action's selected node independent of its changing document. */
export class BaseInput {
    private readonly before;
    private readonly selected;
    private readonly root;
    private readonly document;
    private readonly beforeDocument;
    private readonly selectedDocument;

    constructor(readonly item: Item) {
        this.before = item.clone().node;
        this.selected = item.node;
        this.document = requestDocument(item);
        this.beforeDocument = this.document === item ? undefined : this.document.clone();
        this.selectedDocument = this.document.getItemCount() === 1 ? this.document.node : undefined;
        this.root = documentRoot(this.document);
    }

    change(origins: ManagedOrigins): BaseInputChange | undefined {
        const current = this.document.payload.items[0];
        const detached = !current || itemOrigin(current) !== itemOrigin(this.selected);
        const captured = this.document === this.item && detached ? this.selected : this.item.node;
        const request = requestDifference(this.before, captured);

        if (!detached) {
            if (documentRoot(this.document) !== this.root) {
                throw new PlatformError(
                    "UnsupportedRequestIdentity",
                    "Moving a retained base request into another XML container is not qualified.",
                );
            }

            return request ? { request, origins: origins.capture(this.item.payload) } : undefined;
        }

        if (this.document !== this.item && documentRoot(this.document) === this.root) {
            return this.changedDocument(request, origins, captured);
        }

        const document = documentInput(this.document);

        if (!document) {
            throw new PlatformError(
                "UnsupportedRequestIdentity",
                "A replaced base document requires its native XML and captured request.",
            );
        }

        this.assertReplacementOrigins();
        const retainedDocument = this.retainedDocumentChange();

        return {
            ...(request ? { request } : {}),
            origins: origins.capture({ items: [captured] }),
            document,
            documentOrigins: origins.capture(this.document.payload),
            ...(retainedDocument && this.selectedDocument
                ? {
                      retainedDocument,
                      retainedOrigins: origins.capture({ items: [this.selectedDocument] }),
                  }
                : {}),
        };
    }

    private retainedDocumentChange(): RequestChange | undefined {
        if (!this.beforeDocument || !this.selectedDocument) {
            return undefined;
        }

        return requestDifference(this.beforeDocument.node, this.selectedDocument);
    }

    private assertReplacementOrigins(): void {
        const originals = new Set([...itemNodes({ items: [this.before] })].map(itemOrigin));

        if (this.beforeDocument) {
            for (const node of itemNodes(this.beforeDocument.payload)) {
                originals.add(itemOrigin(node));
            }
        }

        for (const node of itemNodes(this.document.payload)) {
            if (originals.has(itemOrigin(node))) {
                throw new PlatformError(
                    "UnsupportedRequestIdentity",
                    "Moving retained input Items into a replacement document is not qualified.",
                );
            }
        }
    }

    private changedDocument(
        request: RequestChange | undefined,
        origins: ManagedOrigins,
        captured: ItemNode,
    ): BaseInputChange | undefined {
        if (!this.beforeDocument) {
            throw new Error("A separate base document must retain its initial projection.");
        }

        if (this.beforeDocument.getItemCount() !== 1 || this.document.getItemCount() !== 1) {
            if (Bun.deepEquals(this.beforeDocument.payload, this.document.payload)) {
                return request
                    ? { request, origins: origins.capture({ items: [captured] }) }
                    : undefined;
            }

            throw new PlatformError(
                "UnsupportedRequestIdentity",
                "Changing the base document's scalar or collection requires a qualified XML mapping.",
            );
        }

        const documentChange = requestDifference(this.beforeDocument.node, this.document.node);

        if (!request && !documentChange) {
            return undefined;
        }

        return {
            ...(request ? { request } : {}),
            origins: origins.capture({ items: [captured] }),
            ...(documentChange ? { documentChange } : {}),
            documentOrigins: origins.capture(this.document.payload),
        };
    }
}
