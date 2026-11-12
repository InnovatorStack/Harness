import type { ItemNode } from "./item.js";

export enum AmlLogicalOperator {
    And = "and",
    Or = "or",
    Not = "not",
}

export interface AmlPropertyCondition {
    readonly name: string;
    readonly attributes: Readonly<Record<string, string>>;
    readonly value?: string | number | null;
    readonly item?: ItemNode;
}

export interface AmlLogicalGroup {
    readonly operator: AmlLogicalOperator;
    readonly terms: readonly AmlLogicalTerm[];
    /** Repeated direct properties share the root's implicit AND without adding an XML tag. */
    readonly implicit?: boolean;
}

export type AmlLogicalTerm = AmlLogicalGroup | AmlPropertyCondition;

export function logicalOperator(name: string): AmlLogicalOperator | undefined {
    switch (name) {
        case "and": {
            return AmlLogicalOperator.And;
        }
        case "or": {
            return AmlLogicalOperator.Or;
        }
        case "not": {
            return AmlLogicalOperator.Not;
        }
        default: {
            return undefined;
        }
    }
}

/** Item nodes are attached to the caller's work stack; logical decoding never recurses. */
export function decodeLogical(
    value: unknown,
    item: (value: unknown) => ItemNode,
): readonly AmlLogicalGroup[] {
    if (!Array.isArray(value)) {
        throw new TypeError("Logical AML requires an array of groups.");
    }

    const roots: AmlLogicalGroup[] = [];
    const pending: {
        readonly input: unknown;
        readonly output: AmlLogicalTerm[];
        readonly depth: number;
    }[] = [];

    for (let index = value.length - 1; index >= 0; index -= 1) {
        const input: unknown = value[index];
        pending.push({ input, output: roots, depth: 0 });
    }

    let visited = 0;

    while (pending.length > 0) {
        const frame = pending.pop();

        if (!frame || !record(frame.input) || ++visited > 100_000 || frame.depth > 128) {
            throw new TypeError("Logical AML exceeds its node or nesting limit.");
        }

        const operator =
            typeof frame.input.operator === "string"
                ? logicalOperator(frame.input.operator)
                : undefined;

        if (frame.input.operator !== undefined && operator === undefined) {
            throw new TypeError("Invalid logical AML operator.");
        }

        if (operator !== undefined) {
            const terms: AmlLogicalTerm[] = [];
            const implicit = frame.input.implicit === true;

            if (
                !Array.isArray(frame.input.terms) ||
                (implicit && (operator !== AmlLogicalOperator.And || frame.depth !== 0))
            ) {
                throw new TypeError("Invalid logical AML group.");
            }

            frame.output.push({ operator, terms, ...(implicit ? { implicit } : {}) });

            for (let index = frame.input.terms.length - 1; index >= 0; index -= 1) {
                const input: unknown = frame.input.terms[index];
                pending.push({ input, output: terms, depth: frame.depth + 1 });
            }
        } else {
            if (frame.depth === 0) {
                throw new TypeError("Top-level logical AML must contain groups.");
            }

            frame.output.push(decodeCondition(frame.input, item));
        }
    }

    return roots;
}

function decodeCondition(
    value: Record<string, unknown>,
    item: (value: unknown) => ItemNode,
): AmlPropertyCondition {
    if (typeof value.name !== "string" || !record(value.attributes)) {
        throw new TypeError("Logical criteria need a property name and attributes.");
    }

    const attributes: Record<string, string> = {};

    for (const [name, text] of Object.entries(value.attributes)) {
        if (typeof text !== "string") {
            throw new TypeError("Logical property attributes must contain text.");
        }

        Object.defineProperty(attributes, name, { value: text, enumerable: true });
    }

    if (value.item !== undefined && value.item !== null) {
        return { name: value.name, attributes, item: item(value.item) };
    }

    if (
        value.value !== null &&
        typeof value.value !== "string" &&
        (typeof value.value !== "number" || !Number.isFinite(value.value))
    ) {
        throw new TypeError("Logical properties require a scalar value or nested Item.");
    }

    return { name: value.name, attributes, value: value.value };
}

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
