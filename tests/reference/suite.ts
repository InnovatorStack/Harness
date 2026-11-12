import { cases, inputBundle, loadCorpus } from "./corpus.js";
import { NativeReferences } from "./references.js";
import { openReferenceWorld, runCase } from "./runtime.js";
import { ComparisonStatus } from "./types.js";
import type { CaseRun, NativeEvidence, ReferenceCase, ReferenceResult } from "./types.js";

export interface SuiteOptions {
    readonly nativeDirectory?: string;
    readonly requireNative?: boolean;
}

export interface SuiteReport {
    readonly schemaVersion: 1;
    readonly source: "harness";
    readonly passed: boolean;
    readonly results: readonly ReferenceResult[];
    readonly runs: readonly CaseRun[];
    readonly inputs: ReturnType<typeof inputBundle>;
    readonly nativeProfile?: NativeEvidence["profile"];
}

export async function runReferenceSuite(options: SuiteOptions = {}): Promise<SuiteReport> {
    const corpus = await loadCorpus();
    const references = new NativeReferences(options.nativeDirectory);
    await references.validateDirectory();
    using h = await openReferenceWorld();

    if (!Bun.deepEquals(corpus.files, (await loadCorpus()).files)) {
        throw new Error("Reference inputs changed during setup. Run the suite again.");
    }

    const results: ReferenceResult[] = [];
    const runs: CaseRun[] = [];

    for (const definition of cases) {
        try {
            const run = await runCase(h, corpus, definition);
            runs.push(run);
            const contractError = checkContract(definition, run);
            const comparison = await references.compare(run, corpus.anchors);
            results.push({
                ...comparison,
                contractPassed: contractError === undefined,
                ...(contractError ? { contractError } : {}),
            });
        } catch (error) {
            results.push({
                caseId: definition.id,
                contractPassed: false,
                comparison: ComparisonStatus.Invalid,
                differences: [],
                contractError: error instanceof Error ? error.message : String(error),
            });
        }
    }

    return {
        schemaVersion: 1,
        source: "harness",
        inputs: inputBundle(corpus),
        results,
        runs,
        passed: suitePassed(results, options.requireNative ?? false),
        ...(references.profile ? { nativeProfile: references.profile } : {}),
    };
}

export function suitePassed(results: readonly ReferenceResult[], requireNative: boolean): boolean {
    return (
        results.length > 0 &&
        results.every(
            (result) =>
                result.contractPassed &&
                (result.comparison === ComparisonStatus.Matched ||
                    (result.comparison === ComparisonStatus.Pending && !requireNative)),
        )
    );
}

function checkContract(definition: ReferenceCase, run: CaseRun): string | undefined {
    try {
        definition.check(run.observation);

        return undefined;
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
}
