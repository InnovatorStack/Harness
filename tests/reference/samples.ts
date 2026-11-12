import { ExecutionOutcome } from "../../src/index.js";
import { Item } from "../../src/items/item.js";
import type { ItemPayload } from "../../src/items/item.js";
import type { StoredItem } from "../../src/storage/types.js";
import { watchedTypes } from "./model.js";
import type { NativeEvidence, Observation } from "./types.js";

export const fixedId = "11111111111111111111111111111111";
export const otherId = "22222222222222222222222222222222";
export const firstId = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
export const secondId = "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";
export const linkId = "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE";

/** Synthetic comparator inputs, never a recorded native outcome. */
export function sampleObservation(generated = firstId, relationship = linkId): Observation {
    const initial = [
        record("RefDocument", fixedId, "DOC-001", "1"),
        record("RefDocument", otherId, "DOC-002", "1"),
    ];
    const version = record("RefDocument", generated, "DOC-001", "2");
    const link = record("RefLink", relationship, "", "1");
    const properties = {
        ...link.properties,
        source_id: generated,
        related_id: otherId,
        label: "Owned",
    };
    const request = payload(initial[0]);
    const response = payload(version);

    return {
        initial,
        steps: [
            {
                name: "edit",
                request,
                response,
                outcome: ExecutionOutcome.Committed,
                events: [{ event: "onAfterUpdate", method: "RefAfterUpdate", context: response }],
                state: [...initial, version, { ...link, properties }],
            },
        ],
    };
}

function record(type: string, id: string, itemNumber: string, generation: string): StoredItem {
    const projection = watchedTypes.find((entry) => entry.type === type);

    if (!projection) {
        throw new Error("Sample records require an original corpus type.");
    }

    const values: Record<string, string> = {
        item_number: itemNumber,
        generation,
        config_id: fixedId,
        name: "Original",
        note: firstId,
    };
    const properties = Object.fromEntries(
        projection.properties.map((name) => [name, values[name] ?? null]),
    );

    return {
        type,
        id,
        properties,
    };
}

function payload(record: StoredItem | undefined): ItemPayload {
    if (!record) {
        throw new Error("A sample response needs one record.");
    }

    const item = Item.create(record.type);
    item.setAttribute("id", record.id);
    Object.assign(item.node.properties, record.properties);

    return item.payload;
}

export function syntheticEvidence(observation: Observation): NativeEvidence {
    return {
        schemaVersion: 1,
        source: "native-aras",
        caseId: "synthetic-comparator-test",
        inputHash: "a".repeat(64),
        profile: { release: "synthetic", build: "test-only" },
        recordedAt: "2026-01-01T00:00:00Z",
        review: {
            reviewer: "comparator-test",
            reviewedAt: "2026-01-02T00:00:00Z",
            evidence: "Synthetic validation input; no native verification is claimed.",
        },
        observation,
    };
}
