import { cloneData } from "../../core/data.js";
import type { Item, ItemPayload } from "../../items/item.js";
import { itemNodes } from "../../items/origins.js";
import { itemNodeFromElement } from "../../items/xml.js";
import { childElements, textContent } from "../../packages/elements.js";
import { parseXml } from "../../packages/parser.js";
import type { AmlElement } from "../../packages/types.js";
import { PlatformError } from "../../platform/errors.js";
import { requestDifference } from "./request-change.js";
import type { RequestChange } from "./request-change.js";

export interface DocumentInput {
    readonly xml: string;
    readonly change?: RequestChange;
}

interface DocumentSnapshot {
    readonly xml: string;
    readonly item: Item;
    readonly root: symbol;
}

const documents = new WeakMap<ItemPayload, DocumentSnapshot>();

/** Only reloaded native documents need their container and unmodeled XML on the wire. */
export function documentInput(item: Item): DocumentInput | undefined {
    const snapshot = documents.get(item.payload);

    if (!snapshot) {
        return undefined;
    }

    if (snapshot.item.getItemCount() !== 1 || item.getItemCount() !== 1) {
        if (Bun.deepEquals(snapshot.item.payload, item.payload)) {
            return { xml: snapshot.xml };
        }

        throw new PlatformError(
            "UnsupportedRequestIdentity",
            "Changing a reloaded document's collection requires a qualified XML mapping.",
        );
    }

    const change = requestDifference(snapshot.item.node, item.node);

    return { xml: snapshot.xml, ...(change ? { change } : {}) };
}

export function validateDocument(value: unknown, payload: ItemPayload): string | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }

    if (typeof value !== "string") {
        throw new PlatformError("InvalidProtocol", "Managed document XML must be text.");
    }

    const projected = projectDocument(parseXml(value, "<managed document>"));

    if (!Bun.deepEquals(lexicalPayload(projected), lexicalPayload(payload))) {
        throw new PlatformError(
            "InvalidProtocol",
            "Managed document XML disagrees with its Item projection.",
        );
    }

    return value;
}

export function rememberDocument(item: Item, xml: string | undefined, replaced = false): void {
    if (xml !== undefined) {
        const previous = documents.get(item.payload);
        const root = replaced ? Symbol("native document root") : previous?.root;
        documents.set(item.payload, {
            xml,
            item: item.clone(),
            root: root ?? Symbol("native document root"),
        });
    }
}

export function documentRoot(item: Item): symbol | undefined {
    return documents.get(item.payload)?.root;
}

export function readDocument(xml: string): ItemPayload {
    return projectDocument(parseXml(xml, "<managed document>"));
}

function projectDocument(root: AmlElement): ItemPayload {
    if (root.name === "Item") {
        return { items: [itemNodeFromElement(root)] };
    }

    if (root.name === "AML" || root.name === "Result") {
        return projectResult(root);
    }

    if (localName(root) === "Envelope") {
        return projectEnvelope(root);
    }

    throw new PlatformError(
        "UnsupportedRequestIdentity",
        "Reloaded base documents require native AML or SOAP XML.",
    );
}

function projectResult(root: AmlElement): ItemPayload {
    const items = childElements(root).map(itemNodeFromElement);

    if (root.name === "Result" && items.length === 0) {
        return { items: [], result: textContent(root) };
    }

    return { items };
}

function projectEnvelope(root: AmlElement): ItemPayload {
    const body = childElements(root).find((element) => localName(element) === "Body");

    if (!body) {
        throw new PlatformError("InvalidProtocol", "Managed SOAP document has no Body.");
    }

    const elements = childElements(body);
    const fault = elements.find((element) => localName(element) === "Fault");

    if (fault) {
        const fields = childElements(fault);
        const code = fields.find((field) => field.name === "faultcode");
        const message = fields.find((field) => field.name === "faultstring");

        return {
            items: [],
            error: {
                code: code ? textContent(code) : "ApplicationError",
                message: message ? textContent(message) : "Native Method returned a fault.",
            },
        };
    }

    const result = elements.find((element) => element.name === "Result");

    if (!result) {
        throw new PlatformError("InvalidProtocol", "Managed SOAP document has no Result.");
    }

    const payload = projectResult(result);
    const message = elements.find((element) => element.name === "Message");

    if (message) {
        payload.messages = childElements(message).map((event) => ({
            name: event.attributes.name ?? "",
            value: event.attributes.value ?? "",
        }));
    }

    return payload;
}

function localName(element: AmlElement): string {
    return element.name.slice(element.name.indexOf(":") + 1);
}

function lexicalPayload(payload: ItemPayload): ItemPayload {
    const projected = cloneData(payload);

    for (const node of itemNodes(projected)) {
        for (const [name, attributes] of Object.entries(node.propertyAttributes)) {
            if (name !== "Relationships" && Object.keys(attributes).length === 0) {
                delete node.propertyAttributes[name];
            }
        }

        for (const [name, value] of Object.entries(node.properties)) {
            if (Object.hasOwn(node.propertyItems, name)) {
                delete node.properties[name];
            } else if (value !== null) {
                node.properties[name] = String(value);
            }
        }
    }

    return projected;
}
