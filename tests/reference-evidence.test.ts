import { expect, test } from "bun:test";

import { cloneData } from "../src/core/data.js";
import { readEvidence } from "./reference/evidence.js";
import { projectRecord } from "./reference/projection.js";
import { compareReference } from "./reference/references.js";
import { resolveRequest } from "./reference/runtime.js";
import { sampleObservation, syntheticEvidence } from "./reference/samples.js";
import { ComparisonStatus } from "./reference/types.js";

test("native evidence requires explicit origin, release/build, review and exact inputs", () => {
    const evidence = syntheticEvidence(sampleObservation());
    const malformed: readonly unknown[] = [
        { ...evidence, source: "harness" },
        { ...evidence, schemaVersion: 2 },
        { ...evidence, inputHash: "not-a-hash" },
        { ...evidence, profile: { release: "synthetic" } },
        { ...evidence, review: undefined },
        { ...evidence, review: { ...evidence.review, reviewer: "" } },
        { ...evidence, recordedAt: "2026-01-01T00:00:00" },
    ];

    for (const value of malformed) {
        expect(() => readEvidence(value)).toThrow();
    }

    expect(readEvidence(evidence).profile).toEqual(evidence.profile);
});

test("missing native evidence stays pending and source changes invalidate old outcomes", () => {
    const evidence = syntheticEvidence(sampleObservation());
    const run = {
        caseId: evidence.caseId,
        inputHash: evidence.inputHash,
        observation: evidence.observation,
    };
    const anchors = new Set<string>();
    expect(compareReference(run, undefined, anchors).comparison).toBe(ComparisonStatus.Pending);
    expect(compareReference(run, readEvidence(evidence), anchors).comparison).toBe(
        ComparisonStatus.Matched,
    );
    expect(
        compareReference({ ...run, inputHash: "b".repeat(64) }, evidence, anchors).comparison,
    ).toBe(ComparisonStatus.Stale);
    expect(() => compareReference({ ...run, caseId: "different-case" }, evidence, anchors)).toThrow(
        "does not match",
    );
});

test("malformed or incomplete observations cannot become native matches", () => {
    const evidence = syntheticEvidence(sampleObservation());
    const invalid = cloneData(evidence);
    Reflect.set(invalid.observation.steps[0] ?? {}, "outcome", "UNKNOWN");
    expect(() => readEvidence(invalid)).toThrow("settled transaction");
    expect(() =>
        readEvidence({ ...evidence, observation: { ...evidence.observation, steps: [] } }),
    ).toThrow();
    expect(() =>
        readEvidence({
            ...evidence,
            observation: { initial: [{}], steps: evidence.observation.steps },
        }),
    ).toThrow("Invalid reference record");
});

test("native state cannot include unrelated records from shared platform tables", () => {
    const sample = sampleObservation();
    const record = projectRecord({
        type: "Team Identity",
        id: "B7300000000000000000000000000001",
        properties: {
            source_id: "B7200000000000000000000000000001",
            related_id: "A7100000000000000000000000000003",
            team_role: "60EBF9D1BB584921A73FA2F8D74DAF80",
        },
    });
    const valid = syntheticEvidence({ ...sample, initial: [...sample.initial, record] });
    expect(readEvidence(valid).observation.initial).toHaveLength(sample.initial.length + 1);
    const unrelated = {
        ...record,
        properties: { ...record.properties, source_id: "B7200000000000000000000000000099" },
    };
    const invalid = syntheticEvidence({ ...sample, initial: [...sample.initial, unrelated] });
    expect(() => readEvidence(invalid)).toThrow("outside its source scope");
});

test("request binding permits only known native IDs and never substitutes arbitrary XML", () => {
    expect(
        resolveRequest('<Item id="{{document}}" />', new Map([["document", "A".repeat(32)]])),
    ).toBe(`<Item id="${"A".repeat(32)}" />`);
    expect(() => resolveRequest("{{unknown}}", new Map())).toThrow("must resolve");
    expect(() =>
        resolveRequest("{{document}}", new Map([["document", '<Item action="delete" />']])),
    ).toThrow("native item ID");
});
