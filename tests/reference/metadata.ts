import { childElements, textContent } from "../../src/packages/elements.js";
import { parseAml } from "../../src/packages/parser.js";
import type { AmlElement } from "../../src/packages/types.js";
import type { Corpus } from "./corpus.js";

/** Capture labels come from original event/transition bindings, not a second handwritten model. */
export function nativeEventBindings(files: Corpus["files"]): ReadonlyMap<string, string> {
    const items: AmlElement[] = [];

    for (const file of files) {
        const pending = [...parseAml(file.xml, file.path).items];

        while (pending.length > 0) {
            const element = pending.pop();

            if (!element) {
                throw new Error("An element must exist while metadata work is pending.");
            }

            if (element.name === "Item") {
                items.push(element);
            }

            pending.push(...childElements(element));
        }
    }

    const methods = new Map(
        items
            .filter((item) => item.attributes.type === "Method")
            .map((item) => [item.attributes.id, property(item, "name")]),
    );
    const bindings = new Map<string, string>();

    for (const item of items) {
        if (item.attributes.type === "Server Event") {
            bind(
                bindings,
                methods.get(property(item, "related_id")),
                property(item, "server_event"),
            );
        } else if (item.attributes.type === "Life Cycle Transition") {
            for (const phase of ["pre_action", "post_action"]) {
                const methodId = property(item, phase);

                if (methodId) {
                    bind(bindings, methods.get(methodId), phase);
                }
            }
        }
    }

    return bindings;
}

function bind(bindings: Map<string, string>, method: string | undefined, phase: string): void {
    if (!method || !phase || bindings.has(method)) {
        throw new Error("Native event recording requires one original binding per capture Method.");
    }

    bindings.set(method, phase);
}

function property(element: AmlElement, name: string): string {
    const child = childElements(element).find((candidate) => candidate.name === name);

    return child ? textContent(child).trim() : "";
}
