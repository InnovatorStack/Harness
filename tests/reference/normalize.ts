import { cloneData, freezeData } from "../../src/core/data.js";
import { object } from "../../src/items/codec.js";
import type { ItemPayload } from "../../src/items/item.js";
import type { StoredItem } from "../../src/storage/types.js";
import { idProperties, watchedTypes } from "./model.js";
import type { Observation } from "./types.js";

const nativeId = /^[A-F\d]{32}$/iu;

/** Fixed input IDs stay fixed. Only identities observed as owned records/nodes receive aliases. */
export function normalizeObservation(
    observation: Observation,
    anchors: ReadonlySet<string>,
): Observation {
    const identities = new Identities(anchors);

    for (const records of [observation.initial, ...observation.steps.map((step) => step.state)]) {
        identities.registerState(records);
    }

    for (const step of observation.steps) {
        identities.registerPayload(step.request);
        identities.registerPayload(step.response);

        for (const event of step.events) {
            identities.registerPayload(event.context);
        }
    }

    const normalized = cloneData(observation);
    const pending: unknown[] = [normalized];

    while (pending.length > 0) {
        const value = pending.pop();

        if (value !== null && typeof value === "object") {
            for (const [name, child] of Object.entries(value)) {
                if (typeof child === "string" && idProperties.has(name)) {
                    Reflect.set(value, name, identities.value(child));
                } else if (child !== null && typeof child === "object") {
                    pending.push(child);
                }
            }
        }
    }

    return freezeData({
        ...normalized,
        initial: orderedState(normalized.initial, identities),
        steps: normalized.steps.map((step) => ({
            ...step,
            state: orderedState(step.state, identities),
        })),
    });
}

class Identities {
    private readonly generated = new Map<string, string>();

    constructor(private readonly anchors: ReadonlySet<string>) {}

    value(id: string): string {
        if (!nativeId.test(id)) {
            return id;
        }

        const canonical = id.toUpperCase();

        return this.generated.get(canonical) ?? canonical;
    }

    registerState(records: readonly StoredItem[]): void {
        for (const definition of watchedTypes) {
            const group = records.filter((record) => record.type === definition.type);
            const keys = new Set<string>();
            group.sort((left, right) => compareText(stateKey(left, this), stateKey(right, this)));

            for (const record of group) {
                const key = stateKey(record, this);

                if (keys.has(key)) {
                    throw new Error(
                        `Ambiguous reference identity '${key}'. Declare stable unique keys.`,
                    );
                }

                keys.add(key);
                this.register(record.id);
            }
        }
    }

    registerPayload(payload: ItemPayload): void {
        const pending = [...payload.items].reverse();

        while (pending.length > 0) {
            const node = pending.pop();

            if (!node) {
                throw new Error("A pending Item node must exist.");
            }

            if (node.attributes.id) {
                this.register(node.attributes.id);
            }

            pending.push(
                ...[...node.relationships, ...Object.values(node.propertyItems)].reverse(),
            );
        }
    }

    private register(id: string): void {
        if (!nativeId.test(id)) {
            throw new TypeError(`Reference item identity '${id}' is not a native ID.`);
        }

        const canonical = id.toUpperCase();

        if (!this.anchors.has(canonical) && !this.generated.has(canonical)) {
            this.generated.set(canonical, `@generated:${this.generated.size + 1}`);
        }
    }
}

function orderedState(
    records: readonly StoredItem[],
    identities: Identities,
): readonly StoredItem[] {
    return [...records].sort((left, right) =>
        compareText(stateKey(left, identities), stateKey(right, identities)),
    );
}

function stateKey(record: StoredItem, identities: Identities): string {
    const definition = watchedTypes.find((entry) => entry.type === record.type);

    if (!definition) {
        throw new Error(`Unknown reference state type '${record.type}'.`);
    }

    const values = definition.keys.map((name) => {
        const value = record.properties[name];

        if (value === undefined || value === null || object(value)) {
            throw new Error(`Reference identity key '${record.type}.${name}' is missing.`);
        }

        return typeof value === "string" && idProperties.has(name)
            ? identities.value(value)
            : value;
    });

    return JSON.stringify([record.type, ...values]);
}

function compareText(left: string, right: string): number {
    if (left === right) {
        return 0;
    }

    return left < right ? -1 : 1;
}
