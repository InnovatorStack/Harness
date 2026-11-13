import { expect, test } from "bun:test";
import { join } from "node:path";

import { capabilities } from "../src/compatibility/capabilities.js";
import { createEngine } from "../src/engine.js";
import { AuthorizationMode } from "../src/index.js";
import { cases, corpusDirectory, inputBundle, loadCorpus } from "./reference/corpus.js";
import { watchedTypes } from "./reference/model.js";
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
    expect(corpus.files).toHaveLength(20);
    const paths = corpus.files.map((file) => file.path);

    expect(paths).toContain(".harness/packages/request-origins.xml");
    expect(paths).toContain(".harness/fixtures/request-origins.xml");
    expect(paths).toContain(".harness/packages/copy-lifecycles.xml");
    expect(paths).toContain(".harness/packages/event-results.xml");
    expect(paths).toContain(".harness/fixtures/event-results.xml");
    expect(paths).toContain(".harness/packages/property-items.xml");
    expect(paths).toContain(".harness/fixtures/property-items.xml");
    expect(paths).toContain(".harness/packages/document-views.xml");
    expect(paths).toContain(".harness/packages/captured-requests.xml");
    expect(paths).toContain(".harness/fixtures/captured-requests.xml");
    expect(paths).toContain(".harness/packages/add-identities.xml");
    expect(corpus.anchors.size).toBeGreaterThan(20);
    expect(inputBundle(corpus).authorization).toBe(AuthorizationMode.Native);
});

test("reference stored projections contain only unique columns from the original imported schema", async () => {
    using engine = createEngine();
    await engine.loadPackages([join(corpusDirectory, ".harness/packages")]);

    for (const watched of watchedTypes) {
        const definition = engine.storage.getItemType(watched.type);
        expect(definition).toBeDefined();
        expect(new Set(watched.properties).size).toBe(watched.properties.length);

        for (const name of watched.properties) {
            expect(definition?.properties.some((property) => property.name === name)).toBe(true);
        }

        expect(watched.keys.every((key) => watched.properties.includes(key))).toBe(true);
    }
});
