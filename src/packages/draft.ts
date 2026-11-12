import type { SourceLocation } from "../diagnostics/source-location.js";
import type { StorageValue } from "../storage/types.js";
import type { AmlElement } from "./types.js";

interface ItemReference {
    readonly kind: "reference";
    readonly element: AmlElement;
}

interface TypedReference {
    readonly kind: "typed-reference";
    readonly type: string;
    readonly id: string;
    readonly source: SourceLocation;
}

export type PendingValue = StorageValue | ItemReference | TypedReference;

export interface DraftEntry {
    readonly id: string;
    readonly type: string;
    attributes: Readonly<Record<string, string>>;
    properties: Record<string, PendingValue>;
    source: SourceLocation;
}

export interface DraftChange {
    readonly key: string;
    readonly before: DraftEntry | undefined;
    readonly after: DraftEntry | undefined;
    readonly properties: ReadonlySet<string>;
    readonly replacesItem: boolean;
    readonly previousCreator: number | undefined;
}

interface SavedEntry {
    readonly entry: DraftEntry | undefined;
    readonly changed: boolean;
    readonly deleted: DraftEntry | undefined;
    readonly creator: number | undefined;
    readonly properties: Set<string>;
    replacesItem: boolean;
}

interface DraftCheckpoint {
    readonly entries: ReadonlyMap<string, DraftEntry>;
    readonly changed: ReadonlySet<string>;
    readonly deleted: ReadonlyMap<string, DraftEntry>;
    readonly creators: ReadonlyMap<string, number>;
}

export function entryKey(type: string, id: string): string {
    return JSON.stringify([type.toLowerCase(), id.toLowerCase()]);
}

function copy(entry: DraftEntry): DraftEntry {
    return { ...entry, properties: { ...entry.properties } };
}

/** In-memory import state. Failed action attempts restore only the records they touched. */
export class ImportDraft {
    private readonly records = new Map<string, DraftEntry>();
    private readonly recordsByType = new Map<string, Map<string, DraftEntry>>();
    private readonly changedKeys = new Set<string>();
    private readonly deletions = new Map<string, DraftEntry>();
    private readonly creators = new Map<string, number>();
    private journal: Map<string, SavedEntry> | undefined;
    private action: number | undefined;

    constructor(entries: ReadonlyMap<string, DraftEntry>) {
        for (const [key, entry] of entries) {
            this.setRecord(key, entry);
        }
    }

    get entries(): ReadonlyMap<string, DraftEntry> {
        return this.records;
    }

    ofType(type: string): Iterable<DraftEntry> {
        return this.recordsByType.get(type.toLowerCase())?.values() ?? [];
    }

    get changed(): ReadonlySet<string> {
        return this.changedKeys;
    }

    get deleted(): ReadonlyMap<string, DraftEntry> {
        return this.deletions;
    }

    put(entry: DraftEntry): void {
        const key = entryKey(entry.type, entry.id);
        this.capture(key).replacesItem = true;
        this.setRecord(key, entry);
        this.changedKeys.add(key);

        if (this.action !== undefined) {
            this.creators.set(key, this.action);
        }
    }

    touch(entry: DraftEntry, properties: readonly string[]): void {
        const key = entryKey(entry.type, entry.id);
        const saved = this.capture(key);

        for (const name of properties) {
            saved.properties.add(name);
        }

        this.changedKeys.add(key);
    }

    remove(key: string, deletion?: DraftEntry): void {
        this.capture(key).replacesItem = true;
        this.removeRecord(key);
        this.changedKeys.delete(key);
        this.creators.delete(key);

        if (deletion) {
            this.deletions.set(key, deletion);
        }
    }

    begin(action: number): void {
        if (this.journal) {
            throw new Error("An import action attempt is already active.");
        }

        this.action = action;
        this.journal = new Map();
    }

    changes(): readonly DraftChange[] {
        const changes: DraftChange[] = [];

        for (const [key, saved] of this.journal ?? []) {
            const after = this.records.get(key);

            if (!saved.entry && !after) {
                continue;
            }

            changes.push({
                key,
                before: saved.entry,
                after: after ? copy(after) : undefined,
                properties: new Set(saved.properties),
                replacesItem: saved.replacesItem,
                previousCreator: saved.creator,
            });
        }

        return changes;
    }

    commit(): void {
        this.journal = undefined;
        this.action = undefined;
    }

    rollback(): void {
        for (const [key, saved] of this.journal ?? []) {
            if (saved.entry) {
                this.setRecord(key, saved.entry);
            } else {
                this.removeRecord(key);
            }

            this.restoreEntry(key, saved.deleted, this.deletions);

            if (saved.changed) {
                this.changedKeys.add(key);
            } else {
                this.changedKeys.delete(key);
            }

            if (saved.creator === undefined) {
                this.creators.delete(key);
            } else {
                this.creators.set(key, saved.creator);
            }
        }

        this.commit();
    }

    checkpoint(): DraftCheckpoint {
        return {
            entries: new Map([...this.records].map(([key, entry]) => [key, copy(entry)])),
            changed: new Set(this.changedKeys),
            deleted: new Map(this.deletions),
            creators: new Map(this.creators),
        };
    }

    restore(checkpoint: DraftCheckpoint): void {
        this.records.clear();
        this.recordsByType.clear();
        this.changedKeys.clear();
        this.deletions.clear();
        this.creators.clear();

        for (const [key, entry] of checkpoint.entries) {
            this.setRecord(key, copy(entry));
        }

        for (const key of checkpoint.changed) {
            this.changedKeys.add(key);
        }

        for (const [key, entry] of checkpoint.deleted) {
            this.deletions.set(key, entry);
        }

        for (const [key, action] of checkpoint.creators) {
            this.creators.set(key, action);
        }

        this.commit();
    }

    private setRecord(key: string, entry: DraftEntry): void {
        this.records.set(key, entry);
        const type = entry.type.toLowerCase();
        const records = this.recordsByType.get(type) ?? new Map<string, DraftEntry>();
        records.set(key, entry);
        this.recordsByType.set(type, records);
    }

    private removeRecord(key: string): void {
        const entry = this.records.get(key);

        if (!entry) {
            return;
        }

        this.records.delete(key);
        const type = entry.type.toLowerCase();
        const records = this.recordsByType.get(type);
        records?.delete(key);

        if (records?.size === 0) {
            this.recordsByType.delete(type);
        }
    }

    private capture(key: string): SavedEntry {
        const existing = this.journal?.get(key);

        if (existing) {
            return existing;
        }

        const entry = this.records.get(key);
        const saved: SavedEntry = {
            entry: entry ? copy(entry) : undefined,
            changed: this.changedKeys.has(key),
            deleted: this.deletions.get(key),
            creator: this.creators.get(key),
            properties: new Set(),
            replacesItem: false,
        };
        this.journal?.set(key, saved);

        return saved;
    }

    private restoreEntry(
        key: string,
        entry: DraftEntry | undefined,
        target: Map<string, DraftEntry>,
    ): void {
        if (entry) {
            target.set(key, entry);
        } else {
            target.delete(key);
        }
    }
}
