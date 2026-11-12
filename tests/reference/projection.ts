import { getOwn, setOwn } from "../../src/core/data.js";
import { decodePayload, object } from "../../src/items/codec.js";
import type { ItemNode, ItemPayload } from "../../src/items/item.js";
import type { StoredItem } from "../../src/storage/types.js";
import { contextProperties, payloadAttributes, watchedTypes } from "./model.js";

/** Projection is explicit and hashed into the case. Absent stored columns represent SQL null. */
export function projectRecord(record: StoredItem): StoredItem {
    const definition = watchedTypes.find((entry) => entry.type === record.type);

    if (!definition) {
        throw new Error(`No reference projection exists for '${record.type}'.`);
    }

    const properties: Record<string, string | null> = {};

    for (const name of definition.properties) {
        const value = getOwn(record.properties, name);
        setOwn(properties, name, value === null || value === undefined ? null : String(value));
    }

    return { type: record.type, id: record.id, properties };
}

export function projectPayload(value: unknown): ItemPayload {
    // A recorder's snapshot must be complete before it is accepted as a reference observation.
    const payload = decodePayload(value);
    const pending = [...payload.items];

    while (pending.length > 0) {
        const node = pending.pop();

        if (!node) {
            throw new Error("A pending response node must exist.");
        }

        projectNode(node);
        pending.push(...node.relationships, ...Object.values(node.propertyItems));
    }

    return payload;
}

function projectNode(node: ItemNode): void {
    const projection = watchedTypes.find((entry) => entry.type === node.type);

    for (const [name, value] of Object.entries(node.properties)) {
        if (
            projection &&
            !projection.properties.includes(name) &&
            !contextProperties.includes(name)
        ) {
            delete node.properties[name];
            delete node.propertyAttributes[name];
        } else if (value !== null) {
            setOwn(node.properties, name, String(value));
        }
    }

    // Context attributes describe dispatch and transitions; source locations/timings are separate.
    for (const name of Object.keys(node.attributes)) {
        if (!payloadAttributes.includes(name)) {
            delete node.attributes[name];
        }
    }
}

export function methodContext(value: unknown): ItemPayload {
    if (!object(value) || !object(value.context)) {
        throw new TypeError("A Method call must retain its complete input context.");
    }

    return projectPayload(value.context);
}
