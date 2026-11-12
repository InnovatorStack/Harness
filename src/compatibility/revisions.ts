import { PlatformError } from "../platform/errors.js";
import { RevisionSequences } from "../platform/revisions/sequences.js";
import type { HarnessStorage } from "../storage/types.js";
import { CapabilityId } from "./capabilities.js";
import { CompatibilityIssueCode, IssueSeverity } from "./types.js";
import type { CompatibilityIssue } from "./types.js";

/** Sequence validation shares the runtime resolver and never executes business Methods. */
export function inspectRevisions(
    storage: HarnessStorage,
    files: ReadonlySet<string>,
): readonly CompatibilityIssue[] {
    const sequences = new RevisionSequences(storage);
    const issues = new Map<string, CompatibilityIssue>();

    for (const definition of storage.listItemTypes()) {
        if (!definition.isVersionable || !definition.source || !files.has(definition.source.file)) {
            continue;
        }

        try {
            sequences.resolve(definition);
        } catch (error) {
            if (!(error instanceof PlatformError)) {
                throw error;
            }

            const source = error.source ?? definition.source;
            const key = `${error.code}:${source.file}:${source.path}`;
            issues.set(
                key,
                Object.freeze({
                    code: CompatibilityIssueCode.InvalidDefinition,
                    severity: IssueSeverity.Error,
                    capability: CapabilityId.Revision,
                    causeCode: error.code,
                    message: error.message,
                    source,
                }),
            );
        }
    }

    return [...issues.values()];
}
