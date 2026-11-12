import { assertDataTree } from "../../src/core/data.js";
import { ExecutionOutcome } from "../../src/index.js";
import type { StoredItem } from "../../src/index.js";
import { object, decodePayload } from "../../src/items/codec.js";
import { watchedTypes } from "./model.js";
import { recordInScope } from "./projection.js";
import type { NativeEvidence, Observation, StepObservation } from "./types.js";

/** An explicit attestation is required; the suite never promotes its own output into evidence. */
export function readEvidence(value: unknown): NativeEvidence {
    assertDataTree(value, { allowArrays: true, allowUndefined: false });

    if (
        !object(value) ||
        value.schemaVersion !== 1 ||
        value.source !== "native-aras" ||
        !object(value.profile) ||
        !object(value.review)
    ) {
        throw new TypeError(
            "Native evidence requires schemaVersion 1, native-aras provenance, a profile and review.",
        );
    }

    const inputHash = text(value.inputHash);

    if (!/^[a-f\d]{64}$/u.test(inputHash)) {
        throw new TypeError("Native evidence requires the exact SHA-256 input hash.");
    }

    if (Date.parse(timestamp(value.review.reviewedAt)) < Date.parse(timestamp(value.recordedAt))) {
        throw new TypeError("A native outcome must be recorded before its review.");
    }

    return {
        schemaVersion: 1,
        source: "native-aras",
        caseId: text(value.caseId),
        inputHash,
        profile: { release: text(value.profile.release), build: text(value.profile.build) },
        recordedAt: timestamp(value.recordedAt),
        review: {
            reviewer: text(value.review.reviewer),
            reviewedAt: timestamp(value.review.reviewedAt),
            evidence: text(value.review.evidence),
        },
        observation: readObservation(value.observation),
    };
}

export function readObservation(value: unknown): Observation {
    if (
        !object(value) ||
        !Array.isArray(value.steps) ||
        value.steps.length === 0 ||
        value.steps.length > 100
    ) {
        throw new TypeError("A reference observation needs 1–100 steps.");
    }

    return { initial: records(value.initial), steps: value.steps.map(readStep) };
}

function readStep(value: unknown): StepObservation {
    if (
        !object(value) ||
        !Array.isArray(value.events) ||
        value.events.length > 1000 ||
        (value.outcome !== ExecutionOutcome.Committed &&
            value.outcome !== ExecutionOutcome.RolledBack)
    ) {
        throw new TypeError(
            "Reference steps require complete events and a settled transaction outcome.",
        );
    }

    return {
        name: text(value.name),
        request: decodePayload(value.request),
        response: decodePayload(value.response),
        outcome: value.outcome,
        state: records(value.state),
        events: value.events.map((event: unknown) => {
            if (!object(event)) {
                throw new TypeError("Invalid reference event.");
            }

            return {
                method: text(event.method),
                event: text(event.event),
                context: decodePayload(event.context),
            };
        }),
    };
}

function records(value: unknown): readonly StoredItem[] {
    if (!Array.isArray(value) || value.length > 10_000) {
        throw new TypeError("Reference state requires a bounded record array.");
    }

    return value.map((record: unknown) => {
        if (!object(record) || !object(record.properties)) {
            throw new TypeError("Invalid reference record.");
        }

        const type = text(record.type);
        const properties: Record<string, string | null> = {};
        const projection = watchedTypes.find((entry) => entry.type === type);

        if (!projection || Object.keys(record.properties).length !== projection.properties.length) {
            throw new TypeError(
                `Reference state '${type}' must contain every declared stored column.`,
            );
        }

        for (const name of projection.properties) {
            const scalar = record.properties[name];

            if (scalar !== null && typeof scalar !== "string") {
                throw new TypeError(`Reference '${type}.${name}' must be AML text or SQL null.`);
            }

            Object.defineProperty(properties, name, { value: scalar, enumerable: true });
        }

        const parsed = { id: text(record.id), type, properties };

        if (!recordInScope(parsed, projection)) {
            throw new TypeError(
                `Reference state '${type}' contains a record outside its source scope.`,
            );
        }

        return parsed;
    });
}

function text(value: unknown): string {
    if (typeof value !== "string" || !value.trim() || value.length > 4096) {
        throw new TypeError("Reference metadata requires nonempty bounded text.");
    }

    return value;
}

function timestamp(value: unknown): string {
    const date = text(value);

    if (!/(?:Z|[+-]\d{2}:\d{2})$/u.test(date) || !Number.isFinite(Date.parse(date))) {
        throw new TypeError("Reference timestamps require a valid date and explicit timezone.");
    }

    return date;
}
