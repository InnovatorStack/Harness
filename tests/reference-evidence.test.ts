import { expect, test } from "bun:test";

import { cloneData } from "../src/core/data.js";
import { readEvidence } from "./reference/evidence.js";
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

test("request binding permits only known native IDs and never substitutes arbitrary XML", () => {
    expect(
        resolveRequest('<Item id="{{document}}" />', new Map([["document", "A".repeat(32)]])),
    ).toBe(`<Item id="${"A".repeat(32)}" />`);
    expect(() => resolveRequest("{{unknown}}", new Map())).toThrow("must resolve");
    expect(() =>
        resolveRequest("{{document}}", new Map([["document", '<Item action="delete" />']])),
    ).toThrow("native item ID");
});
