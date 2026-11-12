import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withTemporaryDirectory } from "../src/core/resources.js";
import { loadCorpus } from "./reference/corpus.js";
import { nativeEventBindings } from "./reference/metadata.js";
import { readNativeEvents, nativeEventPrefix } from "./reference/native-events.js";
import { NativeReferences } from "./reference/references.js";
import { sampleObservation, syntheticEvidence } from "./reference/samples.js";
import { suitePassed } from "./reference/suite.js";
import { ComparisonStatus } from "./reference/types.js";

test("offline native event logs retain Method order and original AML context", async () => {
    const corpus = await loadCorpus();
    const bindings = nativeEventBindings(corpus.files);
    const xml =
        '<Item type="RefDocument" action="update" id="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"><name>Original</name></Item>';
    const frame = `${nativeEventPrefix}RefBeforeUpdate|${btoa(xml)}`;
    const events = readNativeEvents(`Unrelated server diagnostic\n${frame}\n${frame}`, bindings);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
        method: "RefBeforeUpdate",
        event: "onBeforeUpdate",
        context: {
            items: [{ properties: { name: "Original" }, attributes: { action: "update" } }],
        },
    });
    const wrapped = `${nativeEventPrefix}RefBeforeUpdate|${btoa(`<Result>${xml}</Result>`)}`;
    expect(readNativeEvents(wrapped, bindings)).toEqual(events.slice(0, 1));
    expect(bindings.get("RefPrePromote")).toBe("pre_action");
    expect(bindings.get("RefPostPromote")).toBe("post_action");
    expect(corpus.files.find((file) => file.path.endsWith("methods.xml"))?.xml).toContain(
        "INNOVATOR_HARNESS_REFERENCE_CAPTURE",
    );
});

test("malformed, unknown or oversized native event records fail instead of disappearing", () => {
    const bindings = new Map([["Known", "onAfterUpdate"]]);

    for (const line of [
        nativeEventPrefix,
        `${nativeEventPrefix}Unknown|${btoa("<AML />")}`,
        `${nativeEventPrefix}Known|invalid!`,
        `${nativeEventPrefix}Known|${btoa("<AML />")}`,
        `${nativeEventPrefix}Known|${"a".repeat(262_145)}`,
    ]) {
        expect(() => readNativeEvents(line, bindings)).toThrow();
    }
});

test("reference inputs stay read-only and mixed native profiles fail independently of local contracts", async () => {
    await withTemporaryDirectory(
        join(tmpdir(), "harness-reference-evidence-"),
        async (directory) => {
            const evidence = syntheticEvidence(sampleObservation());
            const text = JSON.stringify(evidence);
            const path = join(directory, `${evidence.caseId}.json`);
            await Bun.write(path, text);
            const references = new NativeReferences(directory);
            await references.validateDirectory();
            const run = {
                caseId: evidence.caseId,
                inputHash: evidence.inputHash,
                observation: evidence.observation,
            };
            expect((await references.compare(run, new Set())).comparison).toBe(
                ComparisonStatus.Matched,
            );
            expect(await Bun.file(path).text()).toBe(text);

            const other = {
                ...evidence,
                caseId: "other-synthetic-case",
                profile: { release: "different", build: "test-only" },
            };
            await Bun.write(join(directory, `${other.caseId}.json`), JSON.stringify(other));
            expect(
                await references.compare({ ...run, caseId: other.caseId }, new Set()),
            ).toMatchObject({ contractPassed: true, comparison: ComparisonStatus.Invalid });
            expect(
                (await references.compare({ ...run, caseId: "missing-case" }, new Set()))
                    .comparison,
            ).toBe(ComparisonStatus.Pending);
        },
    );
});

test("strict native gates reject missing, stale, invalid or different outcomes", () => {
    const base = { caseId: "synthetic", contractPassed: true, differences: [] };
    expect(suitePassed([{ ...base, comparison: ComparisonStatus.Pending }], false)).toBe(true);
    expect(suitePassed([{ ...base, comparison: ComparisonStatus.Pending }], true)).toBe(false);
    expect(suitePassed([{ ...base, comparison: ComparisonStatus.Matched }], true)).toBe(true);
    expect(
        suitePassed(
            [{ ...base, contractPassed: false, comparison: ComparisonStatus.Matched }],
            false,
        ),
    ).toBe(false);
    expect(suitePassed([], false)).toBe(false);

    for (const comparison of [
        ComparisonStatus.Stale,
        ComparisonStatus.Invalid,
        ComparisonStatus.Different,
    ]) {
        expect(suitePassed([{ ...base, comparison }], false)).toBe(false);
    }
});
