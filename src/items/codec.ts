import { assertDataTree, setOwn } from "../core/data.js";
import type { StorageValue } from "../storage/types.js";
import type { ItemNode, ItemPayload } from "./item.js";
import { decodeLogical } from "./logical.js";

export function object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function decodePayload(value: unknown): ItemPayload {
    assertDataTree(value);

    if (!object(value) || !Array.isArray(value.items)) {
        throw new TypeError("Invalid Item payload.");
    }

    const items = value.items.map(decodeNode);
    const payload: ItemPayload = { items };

    if (value.messages !== undefined && value.messages !== null) {
        if (!Array.isArray(value.messages)) {
            throw new TypeError("Item messages must contain native name/value records.");
        }

        payload.messages = value.messages.map((message: unknown) => {
            if (
                !object(message) ||
                typeof message.name !== "string" ||
                typeof message.value !== "string"
            ) {
                throw new TypeError("Invalid Item message.");
            }

            return { name: message.name, value: message.value };
        });
    }

    if (value.result !== undefined && value.result !== null) {
        if (typeof value.result !== "string") {
            throw new TypeError("Invalid Item result.");
        }

        payload.result = value.result;
    }

    if (value.error !== undefined && value.error !== null) {
        if (
            !object(value.error) ||
            typeof value.error.code !== "string" ||
            typeof value.error.message !== "string"
        ) {
            throw new TypeError("Invalid Item error.");
        }

        payload.error = { code: value.error.code, message: value.error.message };
    }

    return payload;
}

interface EncodedNode {
    readonly type: string;
    readonly attributes: Record<string, unknown>;
    readonly properties: Record<string, unknown>;
    readonly propertyItems: Record<string, unknown>;
    readonly relationships: unknown[];
    readonly propertyAttributes?: unknown;
    readonly logical?: unknown;
}

function decodeNode(value: unknown): ItemNode {
    assertNode(value);
    const root = decodeShell(value);
    const pending = [{ value, node: root }];

    while (pending.length > 0) {
        const frame = pending.pop();

        if (!frame) {
            throw new Error("An Item frame must exist while decoding is pending.");
        }

        for (const [name, value] of Object.entries(frame.value.propertyItems)) {
            assertNode(value);
            const node = decodeShell(value);
            setOwn(frame.node.propertyItems, name, node);
            pending.push({ value, node });
        }

        for (const value of frame.value.relationships) {
            assertNode(value);
            const node = decodeShell(value);
            frame.node.relationships.push(node);
            pending.push({ value, node });
        }

        if (frame.value.logical !== undefined && frame.value.logical !== null) {
            frame.node.logical = decodeLogical(frame.value.logical, (value) => {
                assertNode(value);
                const node = decodeShell(value);
                pending.push({ value, node });

                return node;
            });
        }
    }

    return root;
}

function assertNode(value: unknown): asserts value is EncodedNode {
    if (
        !object(value) ||
        typeof value.type !== "string" ||
        !object(value.attributes) ||
        !object(value.properties) ||
        !object(value.propertyItems) ||
        !Array.isArray(value.relationships)
    ) {
        throw new TypeError("Invalid Item node.");
    }
}

function decodeShell(value: EncodedNode): ItemNode {
    const attributes: Record<string, string> = {};

    for (const [key, entry] of Object.entries(value.attributes)) {
        if (typeof entry !== "string") {
            throw new TypeError("Invalid Item attribute.");
        }

        Object.defineProperty(attributes, key, {
            value: entry,
            enumerable: true,
            writable: true,
            configurable: true,
        });
    }

    const properties: Record<string, StorageValue> = {};

    for (const [key, entry] of Object.entries(value.properties)) {
        if (
            entry !== null &&
            typeof entry !== "string" &&
            (typeof entry !== "number" || !Number.isFinite(entry))
        ) {
            throw new TypeError("Invalid Item property.");
        }

        Object.defineProperty(properties, key, {
            value: entry,
            enumerable: true,
            writable: true,
            configurable: true,
        });
    }

    const propertyAttributes = decodePropertyAttributes(value.propertyAttributes);

    return {
        type: value.type,
        attributes,
        properties,
        propertyItems: {},
        propertyAttributes,
        relationships: [],
    };
}

function decodePropertyAttributes(value: unknown): Record<string, Record<string, string>> {
    const propertyAttributes: Record<string, Record<string, string>> = {};

    if (value !== undefined) {
        if (!object(value)) {
            throw new TypeError("Invalid property attributes.");
        }

        for (const [name, attributes] of Object.entries(value)) {
            if (
                !object(attributes) ||
                Object.values(attributes).some((value) => typeof value !== "string")
            ) {
                throw new TypeError("Invalid property attributes.");
            }

            setOwn(
                propertyAttributes,
                name,
                Object.fromEntries(
                    Object.entries(attributes).map(([key, value]) => [key, String(value)]),
                ),
            );
        }
    }

    return propertyAttributes;
}
