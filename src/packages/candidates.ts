import type { DraftEntry } from "./draft.js";
import type { ActionChange, ImportRead } from "./plan.js";

/** One planning pass owns these indexes; selectors still decide whether candidates match. */
export class ImportCandidates {
    private readonly byKey = new Map<string, ActionChange[]>();
    private readonly byType = new Map<string, ActionChange[]>();
    private readonly initialByType = new Map<string, DraftEntry[]>();

    constructor(
        changes: readonly ActionChange[],
        private readonly initial: ReadonlyMap<string, DraftEntry>,
    ) {
        for (const entry of initial.values()) {
            const type = entry.type.toLowerCase();
            const entries = this.initialByType.get(type) ?? [];
            entries.push(entry);
            this.initialByType.set(type, entries);
        }

        for (const candidate of changes) {
            const entry = candidate.change.after ?? candidate.change.before;

            if (!entry) {
                continue;
            }

            const type = entry.type.toLowerCase();
            const typed = this.byType.get(type) ?? [];
            const keyed = this.byKey.get(candidate.change.key) ?? [];
            typed.push(candidate);
            keyed.push(candidate);
            this.byType.set(type, typed);
            this.byKey.set(candidate.change.key, keyed);
        }
    }

    changes(read: ImportRead): readonly ActionChange[] {
        if (read.key !== undefined) {
            return this.byKey.get(read.key) ?? [];
        }

        return this.byType.get(read.type.toLowerCase()) ?? [];
    }

    initialEntries(read: ImportRead): readonly DraftEntry[] {
        if (read.key !== undefined) {
            const entry = this.initial.get(read.key);

            return entry ? [entry] : [];
        }

        return this.initialByType.get(read.type.toLowerCase()) ?? [];
    }
}
