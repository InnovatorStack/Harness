import { join } from "node:path";

import { readTextFile } from "../../src/core/files.js";
import { compareObservations } from "./compare.js";
import { readEvidence } from "./evidence.js";
import { ComparisonStatus } from "./types.js";
import type { CaseRun, NativeEvidence, ReferenceResult } from "./types.js";

/** One input directory is one reviewed native release/build, never an output destination. */
export class NativeReferences {
    private selectedProfile: NativeEvidence["profile"] | undefined;

    constructor(private readonly directory: string | undefined) {}

    get profile(): NativeEvidence["profile"] | undefined {
        return this.selectedProfile;
    }

    async validateDirectory(): Promise<void> {
        if (this.directory && !(await Bun.file(this.directory).stat()).isDirectory()) {
            throw new TypeError("The native reference input must be a directory.");
        }
    }

    async compare(run: CaseRun, anchors: ReadonlySet<string>): Promise<ReferenceResult> {
        try {
            const evidence = await this.load(run.caseId);

            if (evidence) {
                if (
                    this.selectedProfile &&
                    !Bun.deepEquals(evidence.profile, this.selectedProfile)
                ) {
                    throw new Error("Native reference files must share one release/build profile.");
                }

                this.selectedProfile = evidence.profile;
            }

            return compareReference(run, evidence, anchors);
        } catch (error) {
            return {
                caseId: run.caseId,
                contractPassed: true,
                comparison: ComparisonStatus.Invalid,
                differences: [],
                diagnostic: error instanceof Error ? error.message : String(error),
            };
        }
    }

    private async load(caseId: string): Promise<NativeEvidence | undefined> {
        if (!/^[a-z][a-z0-9-]{0,127}$/u.test(caseId)) {
            throw new TypeError("Reference case IDs must be bounded lowercase names.");
        }

        if (!this.directory) {
            return undefined;
        }

        const path = join(this.directory, `${caseId}.json`);

        if (!(await Bun.file(path).exists())) {
            return undefined;
        }

        const value: unknown = JSON.parse(await readTextFile(path, 8 * 1024 * 1024));

        return readEvidence(value);
    }
}

export function compareReference(
    run: CaseRun,
    evidence: NativeEvidence | undefined,
    anchors: ReadonlySet<string>,
): ReferenceResult {
    const base = { caseId: run.caseId, contractPassed: true, differences: [] };

    if (!evidence) {
        return { ...base, comparison: ComparisonStatus.Pending };
    }

    if (evidence.caseId !== run.caseId) {
        throw new Error(
            `Native reference '${evidence.caseId}' does not match case '${run.caseId}'.`,
        );
    }

    const native = {
        profile: evidence.profile,
        recordedAt: evidence.recordedAt,
        review: evidence.review,
    };

    if (evidence.inputHash !== run.inputHash) {
        return {
            ...base,
            native,
            comparison: ComparisonStatus.Stale,
            diagnostic:
                "Reference inputs differ. Review and record this case again on the named native profile.",
        };
    }

    const comparison = compareObservations(evidence.observation, run.observation, anchors);

    return {
        ...base,
        native,
        comparison: comparison.matches ? ComparisonStatus.Matched : ComparisonStatus.Different,
        differences: comparison.differences,
        ...(comparison.truncated
            ? { diagnostic: "Further differences were omitted after the limit." }
            : {}),
    };
}
