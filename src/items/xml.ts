import { setOwn } from "../core/data.js";
import { childElements, textContent } from "../packages/elements.js";
import { parseAml } from "../packages/parser.js";
import type { AmlElement } from "../packages/types.js";
import { Item, itemNode } from "./item.js";
import type { ItemNode } from "./item.js";
import { AmlLogicalOperator, logicalOperator } from "./logical.js";
import type { AmlLogicalGroup, AmlLogicalTerm, AmlPropertyCondition } from "./logical.js";

type Frame =
    | {
          readonly kind: "item";
          readonly element: AmlElement;
          readonly node: ItemNode;
          readonly logical: AmlLogicalGroup[];
          readonly repeated: AmlLogicalTerm[];
          relationshipsSeen: boolean;
      }
    | { readonly kind: "group"; readonly element: AmlElement; readonly terms: AmlLogicalTerm[] };

/** Items and logical groups share one work stack, including nested item-property criteria. */
export function itemNodeFromElement(element: AmlElement): ItemNode {
    const pending: Frame[] = [];
    const root = appendItem(element, pending);

    while (pending.length > 0) {
        const frame = pending.pop();

        if (!frame) {
            throw new Error("An AML frame must exist while conversion is pending.");
        }

        for (const property of childElements(frame.element)) {
            const operator = logicalOperator(property.name);

            if (operator !== undefined) {
                const terms: AmlLogicalTerm[] = [];
                const group = { operator, terms };

                if (Object.keys(property.attributes).length > 0 || textContent(property).trim()) {
                    throw new TypeError("Logical groups cannot contain attributes or mixed text.");
                }

                if (frame.kind === "item") {
                    frame.logical.push(group);
                    frame.node.logical = frame.logical;
                } else {
                    frame.terms.push(group);
                }

                pending.push({ kind: "group", element: property, terms });
            } else if (frame.kind === "item" && property.name === "Relationships") {
                readRelationships(frame, property, pending);
            } else {
                const condition = readProperty(property, pending);

                if (frame.kind === "group") {
                    frame.terms.push(condition);
                } else {
                    storeProperty(frame, condition);
                }
            }
        }
    }

    return root;
}

function readRelationships(
    frame: Extract<Frame, { kind: "item" }>,
    property: AmlElement,
    pending: Frame[],
): void {
    if (
        frame.relationshipsSeen ||
        Object.keys(property.attributes).length > 0 ||
        textContent(property).trim()
    ) {
        throw new TypeError("Relationships requires one unadorned Item collection.");
    }

    frame.relationshipsSeen = true;
    setOwn(frame.node.propertyAttributes, "Relationships", {});

    for (const child of childElements(property)) {
        frame.node.relationships.push(appendItem(child, pending));
    }
}

function appendItem(element: AmlElement, pending: Frame[]): ItemNode {
    const type = element.attributes.type;

    if (element.name !== "Item" || !type) {
        throw new TypeError("Expected a typed AML Item.");
    }

    const node = itemNode(type);
    node.attributes = { ...element.attributes };
    delete node.attributes.type;
    pending.push({
        kind: "item",
        element,
        node,
        logical: [],
        repeated: [],
        relationshipsSeen: false,
    });

    return node;
}

function readProperty(property: AmlElement, pending: Frame[]): AmlPropertyCondition {
    for (const attribute of Object.keys(property.attributes)) {
        if (
            !["is_null", "condition", "type", "keyed_name", "name", "xml:lang"].includes(attribute)
        ) {
            throw new TypeError(`Unsupported AML property attribute '${attribute}'.`);
        }
    }

    const nested = childElements(property);

    if (nested.length > 0) {
        const element = nested[0];

        if (nested.length !== 1 || !element || textContent(property).trim()) {
            throw new TypeError("Only one nested Item is supported in a property.");
        }

        return {
            name: property.name,
            attributes: { ...property.attributes },
            item: appendItem(element, pending),
        };
    }

    return {
        name: property.name,
        attributes: { ...property.attributes },
        value: property.attributes.is_null === "1" ? null : textContent(property),
    };
}

function storeProperty(
    frame: Extract<Frame, { kind: "item" }>,
    condition: AmlPropertyCondition,
): void {
    const { node, logical, repeated } = frame;
    const { name, attributes } = condition;
    const duplicate =
        Object.hasOwn(node.properties, name) ||
        Object.hasOwn(node.propertyItems, name) ||
        (name === "id" && node.attributes.id !== undefined);

    if (duplicate) {
        if (repeated.length === 0) {
            logical.push({ operator: AmlLogicalOperator.And, terms: repeated, implicit: true });
            node.logical = logical;
        }

        repeated.push(condition);

        return;
    }

    setOwn(node.propertyAttributes, name, { ...attributes });

    if (condition.item) {
        setOwn(node.propertyItems, name, condition.item);
    } else if (name === "id" && (!attributes.condition || attributes.condition === "eq")) {
        node.attributes.id = String(condition.value ?? "");
    } else {
        const value = condition.value;

        if (value === undefined || (typeof value === "object" && value !== null)) {
            throw new TypeError("An AML property must retain its scalar value.");
        }

        setOwn(node.properties, name, value);
    }
}

export function parseItems(xml: string): Item[] {
    return parseAml(xml, "<request>").items.map(
        (element) => new Item({ items: [itemNodeFromElement(element)] }),
    );
}
