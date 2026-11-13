import { getOwn, setOwn } from "../core/data.js";
import type { StorageValue } from "../storage/types.js";
import type { AmlLogicalGroup } from "./logical.js";
import { cloneItemPayload } from "./origins.js";

export { AmlLogicalOperator } from "./logical.js";
export type { AmlLogicalGroup, AmlLogicalTerm, AmlPropertyCondition } from "./logical.js";

export interface ItemNode {
    type: string;
    attributes: Record<string, string>;
    properties: Record<string, StorageValue>;
    propertyItems: Record<string, ItemNode>;
    propertyAttributes: Record<string, Record<string, string>>;
    relationships: ItemNode[];
    logical?: readonly AmlLogicalGroup[];
}

export interface ItemError {
    readonly code: string;
    readonly message: string;
}

export interface ItemPayload {
    items: ItemNode[];
    error?: ItemError;
    result?: string;
    messages?: readonly ItemMessage[];
}

export interface ItemMessage {
    readonly name: string;
    readonly value: string;
}

export function itemNode(type: string, action?: string): ItemNode {
    return {
        type,
        attributes: action ? { action } : {},
        properties: {},
        propertyItems: {},
        propertyAttributes: {},
        relationships: [],
    };
}

export class Item {
    constructor(readonly payload: ItemPayload) {}

    static create(type: string, action?: string): Item {
        return new Item({ items: [itemNode(type, action)] });
    }

    static error(message: string, code = "ApplicationError"): Item {
        return new Item({ items: [], error: { code, message } });
    }

    isError(): boolean {
        return this.payload.error !== undefined;
    }

    getErrorString(): string {
        return this.payload.error?.message ?? "";
    }

    getErrorCode(): string {
        return this.payload.error?.code ?? "";
    }

    getResult(): string {
        return this.payload.result ?? "";
    }

    getPropertyAttribute(property: string, attribute: string, fallback = ""): string {
        const attributes = getOwn(this.node.propertyAttributes, property);

        return attributes ? (getOwn(attributes, attribute) ?? fallback) : fallback;
    }

    setPropertyAttribute(property: string, attribute: string, value: string): void {
        let attributes = getOwn(this.node.propertyAttributes, property);

        if (!attributes) {
            attributes = {};
            setOwn(this.node.propertyAttributes, property, attributes);
        }

        setOwn(attributes, attribute, value);
    }

    getItemCount(): number {
        if (this.isError()) {
            return -1;
        }

        return this.payload.items.length;
    }

    getItemByIndex(index: number): Item {
        const node = this.payload.items[index];

        if (!node) {
            throw new RangeError(`Item index ${index} is outside this collection.`);
        }

        return new Item({ items: [node] });
    }

    getID(): string {
        return this.node.attributes.id ?? "";
    }

    getType(): string {
        return this.node.type;
    }

    setType(type: string): void {
        this.node.type = type;
    }

    getAction(): string {
        return this.getAttribute("action", "get");
    }

    setAction(action: string): void {
        this.setAttribute("action", action);
    }

    getAttribute(name: string, fallback = ""): string {
        if (name === "type") {
            return this.node.type;
        }

        return getOwn(this.node.attributes, name) ?? fallback;
    }

    setAttribute(name: string, value: string): void {
        if (name === "type") {
            this.node.type = value;

            return;
        }

        setOwn(this.node.attributes, name, value);
    }

    getProperty(name: string, fallback = ""): string {
        if (name === "id") {
            return this.getID() || fallback;
        }

        const value = getOwn(this.node.properties, name);

        if (value === null || value === undefined) {
            return fallback;
        }

        return String(value);
    }

    setProperty(name: string, value: StorageValue): void {
        if (name === "id") {
            if (typeof value !== "string") {
                throw new TypeError("Item ID must be a string.");
            }

            this.node.attributes.id = value;
        } else {
            delete this.node.propertyItems[name];
            setOwn(this.node.properties, name, value);
        }
    }

    setPropertyItem(name: string, item: Item): void {
        delete this.node.properties[name];
        setOwn(this.node.propertyItems, name, item.node);
    }

    getPropertyItem(name: string): Item | undefined {
        const node = getOwn(this.node.propertyItems, name);

        if (node) {
            return new Item({ items: [node] });
        }

        return undefined;
    }

    addRelationship(item: Item): void {
        this.node.relationships.push(item.node);
    }

    getRelationships(type?: string): Item {
        return new Item({
            items: this.node.relationships.filter(
                (node) => type === undefined || node.type.toLowerCase() === type.toLowerCase(),
            ),
        });
    }

    clone(): Item {
        return new Item(cloneItemPayload(this.payload));
    }

    get node(): ItemNode {
        if (this.isError() || this.payload.items.length !== 1) {
            throw new TypeError("This operation requires one non-error Item.");
        }

        const node = this.payload.items[0];

        if (!node) {
            throw new TypeError("Item is missing its context.");
        }

        return node;
    }
}
