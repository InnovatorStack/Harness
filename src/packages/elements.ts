import { dataDepthMax, dataNodesMax } from "../core/limits.js";
import { PackageImportError } from "./diagnostics.js";
import type { AmlElement } from "./types.js";

export function childElements(element: AmlElement): readonly AmlElement[] {
    return element.children.filter((child) => child.kind === "element");
}

export function textContent(element: AmlElement): string {
    return element.children
        .filter((child) => child.kind !== "element")
        .map((child) => child.value)
        .join("");
}

export function itemType(element: AmlElement): string {
    const type = element.attributes.type?.trim();

    if (element.name !== "Item" || !type) {
        throw new PackageImportError(
            "INVALID_ITEM",
            "Expected an Item with a type.",
            element.source,
        );
    }

    return type;
}

export function itemProperties(element: AmlElement): readonly AmlElement[] {
    const properties = childElements(element).filter((child) => child.name !== "Relationships");
    const names = new Set<string>();

    for (const property of properties) {
        if (names.has(property.name)) {
            throw new PackageImportError(
                "REPEATED_PROPERTY",
                `Repeated property '${property.name}' requires a multi-value or multilingual adapter.`,
                property.source,
            );
        }

        names.add(property.name);
    }

    return properties;
}

/**
 * Preorder traversal preserves declaration order without consuming the JavaScript call stack.
 * @yields {AmlElement} Each element in its original declaration order.
 */
export function* walkElements(roots: readonly AmlElement[]): Generator<AmlElement, void, void> {
    const pending = roots.map((element) => ({ element, depth: 0 })).reverse();
    const visited = new Set<AmlElement>();

    while (pending.length > 0) {
        const frame = pending.pop();

        if (!frame) {
            throw new Error("An AML frame must exist while traversal is pending.");
        }

        if (
            visited.size >= dataNodesMax ||
            frame.depth > dataDepthMax ||
            visited.has(frame.element)
        ) {
            throw new PackageImportError(
                "INVALID_ITEM",
                "AML exceeds its traversal bounds or contains a cycle.",
                frame.element.source,
            );
        }

        visited.add(frame.element);
        yield frame.element;
        const children = childElements(frame.element);

        for (let index = children.length - 1; index >= 0; index -= 1) {
            const element = children[index];

            if (element) {
                pending.push({ element, depth: frame.depth + 1 });
            }
        }
    }
}
