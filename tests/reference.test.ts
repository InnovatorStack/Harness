import { expect, test } from "bun:test";

import { capabilities } from "../src/compatibility/capabilities.js";
import { cases, loadCorpus } from "./reference/corpus.js";
import { runReferenceSuite } from "./reference/suite.js";
import { ComparisonStatus } from "./reference/types.js";

test("original portable cases execute locally without manufacturing native evidence", async () => {
    const report = await runReferenceSuite();
    const failed = report.results.filter((result) => !result.contractPassed);
    expect(failed).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.runs).toHaveLength(cases.length);
    expect(report.results.every((result) => result.comparison === ComparisonStatus.Pending)).toBe(
        true,
    );
    expect(report.source).toBe("harness");
    expect(capabilities.every((capability) => !capability.referenceVerified)).toBe(true);
}, 120_000);

test("reference corpus covers required boundaries with unique cases and source-qualified inputs", async () => {
    const corpus = await loadCorpus();
    expect(new Set(cases.map((definition) => definition.id)).size).toBe(cases.length);
    expect(cases.every((definition) => definition.capabilities.length > 0)).toBe(true);
    expect(cases.every((definition) => definition.steps.length > 0)).toBe(true);
    const first = cases[0];

    if (!first) {
        throw new Error("The reference corpus must contain cases.");
    }

    expect(corpus.hash(first)).toMatch(/^[a-f\d]{64}$/u);
    expect(corpus.hash({ ...first, steps: [] })).not.toBe(corpus.hash(first));
    expect(corpus.files).toHaveLength(4);
    expect(corpus.anchors.size).toBeGreaterThan(20);
});
