import { getOwn, setOwn } from "../../core/data.js";
import { dataDepthMax, dataNodesMax } from "../../core/limits.js";
import type { ItemNode } from "../../items/item.js";
import { itemOrigin } from "../../items/origins.js";
import { PlatformError } from "../../platform/errors.js";
import { relationshipOrder } from "./relationship-order.js";
import type { RelationshipPosition } from "./relationship-order.js";

interface RequestNode {
    readonly type: string;
    attributes?: ItemNode["attributes"];
    properties?: ItemNode["properties"];
    propertyAttributes?: ItemNode["propertyAttributes"];
    propertyItems?: Record<string, RequestNode>;
    relationships?: RequestNode[];
    logical?: ItemNode["logical"];
}

export interface RequestChange {
    readonly before: RequestNode;
    readonly after: RequestNode;
    readonly alignment?: RequestAlignment;
}

interface RequestAlignment {
    properties?: Record<string, RequestAlignment>;
    relationships?: readonly (RelationshipPosition & { readonly alignment?: RequestAlignment })[];
}

interface Difference {
    readonly before: RequestNode;
    readonly after: RequestNode;
    alignment?: RequestAlignment;
    changed: boolean;
}

interface Frame {
    readonly before: ItemNode;
    readonly after: ItemNode;
    readonly result: Difference;
    readonly properties: { readonly name: string; readonly result: Difference }[];
    readonly relationships: Difference[];
    readonly depth: number;
    order?: readonly RelationshipPosition[];
    finish: boolean;
}

/** Carry changes only: unchanged business values must not multiply the callback byte budget. */
export function requestDifference(before: ItemNode, after: ItemNode): RequestChange | undefined {
    assertPreservedOrigin(before, after, "request root");
    const root = createFrame(before, after, 0);
    const pending = [root];
    let visited = 0;

    while (pending.length > 0) {
        const current = pending.pop();

        if (
            !current ||
            (!current.finish && ++visited > dataNodesMax) ||
            current.depth > dataDepthMax ||
            pending.length > dataNodesMax
        ) {
            throw new PlatformError(
                "ProtocolLimit",
                "Native request changes exceed their tree budget.",
            );
        }

        if (current.finish) {
            completeFrame(current);
            continue;
        }

        compareFields(current);
        current.finish = true;
        pending.push(current);
        comparePropertyItems(current, pending);
        compareRelationships(current, pending);
    }

    return root.result.changed
        ? {
              before: root.result.before,
              after: root.result.after,
              ...(root.result.alignment ? { alignment: root.result.alignment } : {}),
          }
        : undefined;
}

function createFrame(before: ItemNode, after: ItemNode, depth: number): Frame {
    return {
        before,
        after,
        depth,
        result: {
            before: { type: before.type },
            after: { type: after.type },
            changed: before.type !== after.type,
        },
        properties: [],
        relationships: [],
        finish: false,
    };
}

function compareFields(current: Frame): void {
    const { before, after, result } = current;
    const attributes = compareValues(before.attributes, after.attributes);
    const properties = compareValues(before.properties, after.properties);
    const propertyAttributes = compareValues(before.propertyAttributes, after.propertyAttributes);
    result.before.attributes = attributes.before;
    result.after.attributes = attributes.after;
    result.before.properties = properties.before;
    result.after.properties = properties.after;
    result.before.propertyAttributes = propertyAttributes.before;
    result.after.propertyAttributes = propertyAttributes.after;
    result.changed ||= attributes.changed || properties.changed || propertyAttributes.changed;

    for (const name of new Set([
        ...Object.keys(propertyAttributes.before),
        ...Object.keys(propertyAttributes.after),
    ])) {
        const previous = getOwn(before.properties, name);
        const next = getOwn(after.properties, name);

        if (previous !== undefined) {
            setOwn(properties.before, name, previous);
        }

        if (next !== undefined) {
            setOwn(properties.after, name, next);
        }
    }

    if (!Bun.deepEquals(before.logical, after.logical)) {
        result.before.logical = before.logical;
        result.after.logical = after.logical;
        // Implicit logical groups can repeat scalar and Item-valued property names.
        result.before.properties = { ...before.properties };
        result.after.properties = { ...after.properties };
        result.before.propertyAttributes = { ...before.propertyAttributes };
        result.after.propertyAttributes = { ...after.propertyAttributes };
        result.before.propertyItems = { ...before.propertyItems };
        result.after.propertyItems = { ...after.propertyItems };
        result.changed = true;
    }
}

function compareValues<Value>(
    before: Readonly<Record<string, Value>>,
    after: Readonly<Record<string, Value>>,
) {
    const previous: Record<string, Value> = {};
    const next: Record<string, Value> = {};
    let changed = false;

    for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
        const left = getOwn(before, name);
        const right = getOwn(after, name);

        if (Bun.deepEquals(left, right)) {
            continue;
        }

        if (left !== undefined) {
            setOwn(previous, name, left);
        }

        if (right !== undefined) {
            setOwn(next, name, right);
        }

        changed = true;
    }

    return { before: previous, after: next, changed };
}

function comparePropertyItems(current: Frame, pending: Frame[]): void {
    const { before, after, result } = current;

    for (const name of new Set([
        ...Object.keys(before.propertyItems),
        ...Object.keys(after.propertyItems),
    ])) {
        const previous = getOwn(before.propertyItems, name);
        const next = getOwn(after.propertyItems, name);

        if (previous && next) {
            assertPreservedOrigin(previous, next, `Item-valued property '${name}'`);
            const child = createFrame(previous, next, current.depth + 1);
            current.properties.push({ name, result: child.result });
            pending.push(child);
        } else {
            if (previous) {
                result.before.propertyItems ??= {};
                setOwn(result.before.propertyItems, name, { type: previous.type });
            }

            if (next) {
                result.after.propertyItems ??= {};
                setOwn(result.after.propertyItems, name, next);
            }

            result.changed = true;
        }
    }
}

function assertPreservedOrigin(before: ItemNode, after: ItemNode, location: string): void {
    const origin = itemOrigin(before);

    if (origin !== undefined && origin !== itemOrigin(after)) {
        throw new PlatformError(
            "UnsupportedRequestIdentity",
            `Replacing the native ${location} requires a qualified DOM replacement profile.`,
        );
    }
}

function compareRelationships(current: Frame, pending: Frame[]): void {
    const { before, after, result } = current;
    const previous: RequestNode[] = before.relationships.map((node) => ({ type: node.type }));
    const next: RequestNode[] = [...after.relationships];
    const order = relationshipOrder(before.relationships, after.relationships);
    current.order = order;

    for (const position of order) {
        const left =
            position.before === undefined ? undefined : before.relationships[position.before];
        const right =
            position.after === undefined ? undefined : after.relationships[position.after];

        if (left && right && position.before !== undefined && position.after !== undefined) {
            const child = createFrame(left, right, current.depth + 1);
            current.relationships.push(child.result);
            previous[position.before] = child.result.before;
            next[position.after] = child.result.after;
            pending.push(child);
        } else {
            result.changed = true;
        }
    }

    result.before.relationships = previous;
    result.after.relationships = next;

    if (Object.hasOwn(before.propertyAttributes, "Relationships")) {
        result.before.propertyAttributes ??= {};
        setOwn(result.before.propertyAttributes, "Relationships", {});
    }

    if (Object.hasOwn(after.propertyAttributes, "Relationships")) {
        result.after.propertyAttributes ??= {};
        setOwn(result.after.propertyAttributes, "Relationships", {});
    }
}

function completeFrame(current: Frame): void {
    const { result } = current;

    for (const child of current.properties) {
        if (
            child.result.changed ||
            Object.hasOwn(result.before.propertyAttributes ?? {}, child.name) ||
            Object.hasOwn(result.after.propertyAttributes ?? {}, child.name)
        ) {
            result.before.propertyItems ??= {};
            result.after.propertyItems ??= {};
            setOwn(result.before.propertyItems, child.name, child.result.before);
            setOwn(result.after.propertyItems, child.name, child.result.after);
            result.changed = true;

            if (child.result.alignment) {
                result.alignment ??= {};
                result.alignment.properties ??= {};
                setOwn(result.alignment.properties, child.name, child.result.alignment);
            }
        }
    }

    if (
        current.relationships.some((child) => child.changed) ||
        current.order?.some((position) => position.before !== position.after)
    ) {
        result.changed = true;
        result.alignment ??= {};
        let matched = 0;
        result.alignment.relationships = (current.order ?? []).map((position) => {
            const child =
                position.before === undefined || position.after === undefined
                    ? undefined
                    : current.relationships[matched++];

            return child?.alignment ? { ...position, alignment: child.alignment } : position;
        });
    } else if (current.before.relationships.length === current.after.relationships.length) {
        delete result.before.relationships;
        delete result.after.relationships;
    }

    compactNode(result.before);
    compactNode(result.after);
}

function compactNode(node: RequestNode): void {
    const fields: readonly (
        | "attributes"
        | "properties"
        | "propertyAttributes"
        | "propertyItems"
    )[] = ["attributes", "properties", "propertyAttributes", "propertyItems"];

    for (const name of fields) {
        const values = node[name];

        if (values && Object.keys(values).length === 0) {
            delete node[name];
        }
    }

    if (node.relationships?.length === 0) {
        delete node.relationships;
    }
}
