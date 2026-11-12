import { setOwn, getOwn } from "../core/data.js";
import { dataBytesMax, dataDepthMax, dataNodesMax } from "../core/limits.js";
import { itemNode } from "../items/item.js";
import type { ItemNode } from "../items/item.js";
import type { HarnessStorage, ItemTypeDefinition, StoredItem } from "../storage/types.js";
import { PlatformError } from "./errors.js";
import { projectedProperties } from "./query.js";

interface Selection {
    readonly name: string;
    readonly children?: readonly Selection[];
}

type VisibleItem = (definition: ItemTypeDefinition, record: StoredItem) => boolean;

/** Read projection only; business actions and events remain in the dispatcher. */
export function projectItem(
    storage: HarnessStorage,
    definition: ItemTypeDefinition,
    record: StoredItem,
    expression?: string,
): ItemNode {
    return compileProjection(storage, definition, expression)(record);
}

export function compileProjection(
    storage: HarnessStorage,
    definition: ItemTypeDefinition,
    expression?: string,
    visible?: VisibleItem,
): (record: StoredItem) => ItemNode {
    const selection = expression ? new SelectParser(expression).parse() : undefined;
    const pending = [{ definition, fields: selection ?? [] }];

    while (pending.length > 0) {
        const frame = pending.pop();

        if (!frame) {
            throw new Error("A projection frame must exist while metadata validation is pending.");
        }

        for (const field of frame.fields) {
            if (field.name === "*" || field.name === "id") {
                if (field.children) {
                    throw new PlatformError(
                        "UnsupportedSelect",
                        "Only item properties can expand.",
                    );
                }

                continue;
            }

            const property = frame.definition.properties.find(
                (property) => property.name === field.name,
            );

            if (!property) {
                throw new PlatformError(
                    "UnknownProperty",
                    `Unknown property '${frame.definition.name}.${field.name}'.`,
                );
            }

            if (field.children) {
                const target = storage
                    .listItemTypes()
                    .find((type) => type.id === property.dataSource);

                if (property.dataType !== "item" || !target) {
                    throw new PlatformError(
                        "UnsupportedSelect",
                        `Property '${field.name}' has no ItemType target to expand.`,
                    );
                }

                pending.push({ definition: target, fields: field.children });
            }
        }
    }

    return (record) => project(storage, definition, record, selection, visible);
}

function project(
    storage: HarnessStorage,
    definition: ItemTypeDefinition,
    record: StoredItem,
    selection: readonly Selection[] | undefined,
    visible: VisibleItem | undefined,
): ItemNode {
    const node = projectionNode(storage, definition, record, selection);
    const pending = [{ node, definition, record, selection, depth: 0 }];
    let visited = 0;

    while (pending.length > 0) {
        const frame = pending.pop();

        if (!frame) {
            throw new Error("A projection frame must exist while expansion is pending.");
        }

        visited += 1;

        if (visited > dataNodesMax || frame.depth > dataDepthMax) {
            throw new PlatformError(
                "UnsupportedSelect",
                "Projection exceeds its work or nesting limit.",
            );
        }

        for (const field of frame.selection ?? []) {
            if (!field.children) {
                continue;
            }

            const target = expansionTarget(storage, frame.definition, frame.record, field.name);

            if (!target || (visible && !visible(target.definition, target.record))) {
                continue;
            }

            const node = projectionNode(storage, target.definition, target.record, field.children);
            setOwn(frame.node.propertyItems, field.name, node);
            pending.push({ ...target, node, selection: field.children, depth: frame.depth + 1 });
        }
    }

    return node;
}

function projectionNode(
    storage: HarnessStorage,
    definition: ItemTypeDefinition,
    record: StoredItem,
    selection: readonly Selection[] | undefined,
): ItemNode {
    const node = itemNode(definition.name);
    const names = selection?.some((field) => field.name === "*")
        ? undefined
        : selection?.map((field) => field.name);
    node.attributes.id = record.id;
    node.properties = projectedProperties(storage, definition, record, names);

    return node;
}

function expansionTarget(
    storage: HarnessStorage,
    definition: ItemTypeDefinition,
    record: StoredItem,
    name: string,
): { definition: ItemTypeDefinition; record: StoredItem } | undefined {
    const property = definition.properties.find((property) => property.name === name);
    const targetType = storage.listItemTypes().find((type) => type.id === property?.dataSource);

    if (property?.dataType !== "item" || !targetType) {
        throw new PlatformError(
            "UnsupportedSelect",
            `'${definition.name}.${name}' has no ItemType target to expand.`,
        );
    }

    const id = getOwn(record.properties, name);

    if (id === undefined || id === null || id === "") {
        return undefined;
    }

    const target = typeof id === "string" ? storage.getItem(targetType.name, id) : undefined;

    if (!target) {
        throw new PlatformError(
            "MissingReference",
            `Cannot expand '${definition.name}.${name}': target '${id}' is missing.`,
        );
    }

    return { definition: targetType, record: target };
}

class SelectParser {
    private offset = 0;

    constructor(private readonly expression: string) {}

    parse(): readonly Selection[] {
        if (this.expression.length > dataBytesMax) {
            this.fail();
        }

        const fields: Selection[] = [];
        const pending = [{ fields, expectsField: true }];
        let count = 0;

        while (this.offset <= this.expression.length) {
            const frame = pending.at(-1);

            if (!frame) {
                throw new Error("A select frame must exist while parsing is pending.");
            }

            this.whitespace();

            if (frame.expectsField) {
                count += 1;

                if (count > dataNodesMax || pending.length > dataDepthMax) {
                    this.fail();
                }

                const name = /^(?:[A-Za-z_][\w]*|\*)/.exec(this.expression.slice(this.offset))?.[0];

                if (!name) {
                    this.fail();
                }

                this.offset += name.length;
                this.whitespace();
                frame.expectsField = false;

                if (this.expression[this.offset] === "(") {
                    if (name === "*") {
                        this.fail();
                    }

                    const children: Selection[] = [];
                    frame.fields.push({ name, children });
                    pending.push({ fields: children, expectsField: true });
                    this.offset += 1;
                } else {
                    frame.fields.push({ name });
                }
            } else if (this.expression[this.offset] === ",") {
                frame.expectsField = true;
                this.offset += 1;
            } else if (this.expression[this.offset] === ")" && pending.length > 1) {
                pending.pop();
                this.offset += 1;
            } else if (this.offset === this.expression.length && pending.length === 1) {
                return fields;
            } else {
                this.fail();
            }
        }

        return this.fail();
    }

    private whitespace(): void {
        while (/\s/.test(this.expression[this.offset] ?? "")) {
            this.offset += 1;
        }
    }

    private fail(): never {
        throw new PlatformError(
            "UnsupportedSelect",
            `Invalid select '${this.expression}' at position ${this.offset + 1}.`,
        );
    }
}
