import { WorkBudget } from "../core/budget.js";
import { setOwn, getOwn } from "../core/data.js";
import { dataNodesMax, workUnitsMax } from "../core/limits.js";
import type { SourceLocation } from "../diagnostics/source-location.js";
import { stableId } from "./bootstrap.js";
import { ImportCandidates } from "./candidates.js";
import { PackageImportError } from "./diagnostics.js";
import { entryKey } from "./draft.js";
import type { DraftChange, DraftEntry, PendingValue } from "./draft.js";
import { childElements, itemType, textContent } from "./elements.js";
import type { AmlDocument, AmlElement } from "./types.js";

export interface ImportAction {
    readonly id: number;
    readonly element: AmlElement;
    readonly fixture: boolean;
}

export interface ImportRead {
    readonly kind: "unique" | "absent" | "optional";
    readonly type: string;
    readonly source: SourceLocation;
    readonly matchedKeys: readonly string[];
    readonly key?: string;
    matches(entry: DraftEntry): boolean;
}

export interface ImportAttempt {
    readonly reads: readonly ImportRead[];
    readonly changes: readonly DraftChange[];
    readonly error?: PackageImportError;
}

interface PlannerHost {
    reset(): void;
    attempt(action: ImportAction): ImportAttempt;
    equal(left: PendingValue | undefined, right: PendingValue | undefined): boolean;
}

export interface ActionChange {
    readonly action: ImportAction;
    readonly change: DraftChange;
}

/** File order is fixed. Cross-file constraints are added only when selectors require them. */
class ImportOrder {
    private readonly predecessors = new Map<number, Set<number>>();
    private readonly successors = new Map<number, Set<number>>();
    private readonly reachability = new Map<string, boolean>();

    constructor(
        private readonly actions: readonly ImportAction[],
        private readonly work: WorkBudget,
    ) {
        const previous = new Map<string, ImportAction>();

        for (const action of actions) {
            const file = action.element.source.file;
            const preceding = previous.get(file);

            if (preceding) {
                this.connect(preceding.id, action.id);
            }

            previous.set(file, action);
        }
    }

    precedes(before: ImportAction, after: ImportAction): boolean {
        if (!before.fixture && after.fixture) {
            return true;
        }

        if (before.fixture && !after.fixture) {
            return false;
        }

        if (before.element.source.file === after.element.source.file) {
            return before.id < after.id;
        }

        if (!this.successors.has(before.id)) {
            return false;
        }

        const key = `${before.id}:${after.id}`;

        if (this.reachability.size >= 100_000) {
            this.reachability.clear();
        }

        const existing = this.reachability.get(key);

        if (existing !== undefined) {
            return existing;
        }

        const pending = [before.id];
        const visited = new Set<number>();

        while (pending.length > 0) {
            this.work.spend();
            const id = pending.pop();

            if (id === undefined || visited.has(id)) {
                continue;
            }

            visited.add(id);

            for (const next of this.successors.get(id) ?? []) {
                this.work.spend();

                if (next === after.id) {
                    this.reachability.set(key, true);

                    return true;
                }

                pending.push(next);
            }
        }

        this.reachability.set(key, false);

        return false;
    }

    ready(action: ImportAction, completed: ReadonlySet<number>): boolean {
        this.work.spend(this.actions.length);

        if (
            action.fixture &&
            this.actions.some((candidate) => !candidate.fixture && !completed.has(candidate.id))
        ) {
            return false;
        }

        return [...(this.predecessors.get(action.id) ?? [])].every((id) => completed.has(id));
    }

    require(before: ImportAction, after: ImportAction): boolean {
        if (this.precedes(before, after)) {
            return false;
        }

        if (
            before.id === after.id ||
            this.precedes(after, before) ||
            (before.fixture && !after.fixture)
        ) {
            throw conflict(
                "CYCLIC_IMPORT_ORDER",
                "This dependency contradicts the XML action sequence or forms an import cycle. Keep the required creation before its use.",
                after,
                before,
            );
        }

        this.connect(before.id, after.id);

        return true;
    }

    private connect(before: number, after: number): void {
        this.work.spend();
        const preceding = this.predecessors.get(after) ?? new Set<number>();
        preceding.add(before);
        this.predecessors.set(after, preceding);
        const following = this.successors.get(before) ?? new Set<number>();
        following.add(after);
        this.successors.set(before, following);
        this.reachability.clear();
    }
}

export class ImportPlan {
    readonly actions: readonly ImportAction[];
    readonly sharedAdditions: ReadonlySet<string>;
    private readonly order: ImportOrder;
    private readonly work: WorkBudget;
    private readonly declarationErrors: readonly PackageImportError[];
    private readonly declarations: readonly ActionChange[];

    constructor(
        documents: readonly AmlDocument[],
        fixtures: ReadonlySet<string>,
        private readonly initialEntries: ReadonlyMap<string, DraftEntry>,
    ) {
        const actions: ImportAction[] = [];

        for (const document of documents) {
            for (const element of document.items) {
                actions.push({ id: actions.length, element, fixture: fixtures.has(document.file) });
            }
        }

        this.actions = actions;
        this.work = new WorkBudget(
            workUnitsMax,
            () =>
                new PackageImportError(
                    "IMPORT_WORK_LIMIT",
                    "Package planning exceeded its work limit.",
                    actions[0]?.element.source ?? {
                        file: "<packages>",
                        line: 1,
                        column: 1,
                        path: "/",
                    },
                ),
        );
        this.order = new ImportOrder(actions, this.work);
        this.declarations = declaredAdditions(documents, actions);
        this.declarationErrors = duplicateDeclarations(this.declarations);
        this.sharedAdditions = sharedAdditions(this.declarations, initialEntries, this.work);
    }

    execute(host: PlannerHost): readonly PackageImportError[] {
        while (true) {
            this.work.spend();
            host.reset();
            const completed = new Set<number>();
            const attempts = new Map<number, ImportAttempt>();
            let progressed = true;

            while (progressed) {
                this.work.spend();
                progressed = false;

                for (const action of this.actions) {
                    this.work.spend();

                    if (completed.has(action.id) || !this.order.ready(action, completed)) {
                        continue;
                    }

                    const attempt = host.attempt(action);
                    attempts.set(action.id, attempt);

                    if (!attempt.error) {
                        completed.add(action.id);
                        progressed = true;
                    }
                }
            }

            const changes = this.actionChanges(attempts);
            const future = this.declarations.filter(({ action }) => !attempts.has(action.id));
            const inferred = this.inferDependencies(attempts, [...changes, ...future]);

            if (inferred.cyclic) {
                return uniqueErrors([
                    ...this.declarationErrors,
                    ...inferred.errors,
                    ...this.attemptErrors(attempts),
                ]);
            }

            if (inferred.changed) {
                continue;
            }

            return uniqueErrors([
                ...this.declarationErrors,
                ...inferred.errors,
                ...this.attemptErrors(attempts),
                ...this.conflictingChanges(changes, host),
                ...this.optionalReadConflicts(attempts, changes),
            ]);
        }
    }

    private actionChanges(attempts: ReadonlyMap<number, ImportAttempt>): ActionChange[] {
        const changes: ActionChange[] = [];

        for (const action of this.actions) {
            for (const change of attempts.get(action.id)?.changes ?? []) {
                changes.push({ action, change });
            }
        }

        return changes;
    }

    private inferDependencies(
        attempts: ReadonlyMap<number, ImportAttempt>,
        changes: readonly ActionChange[],
    ): { changed: boolean; cyclic: boolean; errors: PackageImportError[] } {
        const errors: PackageImportError[] = [];
        let changed = false;
        let cyclic = false;
        const index = new ImportCandidates(changes, this.initialEntries);

        for (const reader of this.actions) {
            const attempt = attempts.get(reader.id);

            for (const read of attempt?.reads ?? []) {
                if (read.kind === "optional") {
                    continue;
                }

                if (read.kind === "unique" && read.matchedKeys.length > 1) {
                    continue;
                }

                try {
                    const candidates = index
                        .changes(read)
                        .filter(({ action }) => action.id !== reader.id);

                    if (
                        read.kind === "unique" &&
                        this.ambiguousProviders(
                            reader,
                            read,
                            candidates,
                            index.initialEntries(read),
                        )
                    ) {
                        errors.push(
                            new PackageImportError(
                                "AMBIGUOUS_REFERENCE",
                                "This selector has multiple possible providers in different files. Its target cannot be chosen from filename order.",
                                read.source,
                                {
                                    relatedSources: candidates.map(
                                        ({ action }) => action.element.source,
                                    ),
                                },
                            ),
                        );
                        continue;
                    }

                    changed =
                        this.requireReadProviders(reader, read, candidates, attempt?.error) ||
                        changed;
                } catch (error) {
                    if (!(error instanceof PackageImportError)) {
                        throw error;
                    }

                    errors.push(error);
                    cyclic ||= error.code === "CYCLIC_IMPORT_ORDER";
                }
            }
        }

        return { changed, cyclic, errors };
    }

    private requireReadProviders(
        reader: ImportAction,
        read: ImportRead,
        candidates: readonly ActionChange[],
        error: PackageImportError | undefined,
    ): boolean {
        let changed = false;

        for (const writer of candidates) {
            const after = this.providerEffect(reader, read, writer, error);

            if (after === undefined) {
                continue;
            }

            const selected = read.matchedKeys[0];
            const mustMatch =
                read.kind === "unique" &&
                (selected === undefined || selected === writer.change.key);
            const writerFirst = mustMatch ? after : !after;
            changed =
                this.order.require(
                    writerFirst ? writer.action : reader,
                    writerFirst ? reader : writer.action,
                ) || changed;
        }

        return changed;
    }

    private providerEffect(
        reader: ImportAction,
        read: ImportRead,
        writer: ActionChange,
        error: PackageImportError | undefined,
    ): boolean | undefined {
        const sameFile = reader.element.source.file === writer.action.element.source.file;
        const failedForwardRead =
            error?.code === "MISSING_REFERENCE" &&
            read.kind === "unique" &&
            read.matchedKeys.length === 0;

        if (sameFile && !failedForwardRead) {
            return undefined;
        }

        if (
            !failedForwardRead &&
            (this.order.precedes(reader, writer.action) ||
                this.order.precedes(writer.action, reader))
        ) {
            return undefined;
        }

        const before = writer.change.before ? read.matches(writer.change.before) : false;
        const after = writer.change.after ? read.matches(writer.change.after) : false;

        if (before === after) {
            return undefined;
        }

        if (read.kind === "absent" && writer.change.after) {
            return undefined;
        }

        // A delete may legally match nothing. Its observed removal must not invent ordering.
        if (!writer.change.after && read.kind === "unique") {
            return undefined;
        }

        if (
            read.kind === "absent" &&
            !after &&
            (writer.change.previousCreator !== undefined ||
                !this.initialEntries.has(writer.change.key))
        ) {
            return undefined;
        }

        return after;
    }

    private ambiguousProviders(
        reader: ImportAction,
        read: ImportRead,
        changes: readonly ActionChange[],
        initial: readonly DraftEntry[],
    ): boolean {
        const providers = new Map<string, ImportAction | undefined>();

        for (const entry of initial) {
            if (read.matches(entry)) {
                providers.set(entryKey(entry.type, entry.id), undefined);
            }
        }

        for (const { action, change } of changes) {
            if (
                change.after &&
                read.matches(change.after) &&
                (!providers.has(change.key) || !change.before)
            ) {
                providers.set(change.key, action);
            }
        }

        if (providers.size < 2 || read.matchedKeys.length > 1) {
            return false;
        }

        const selected = read.matchedKeys[0];

        if (!selected || !providers.has(selected)) {
            return true;
        }

        const creator = providers.get(selected);

        if (creator) {
            return !this.order.precedes(creator, reader);
        }

        return changes.some(
            ({ action, change }) =>
                change.key === selected &&
                change.before &&
                read.matches(change.before) &&
                (!change.after || !read.matches(change.after)) &&
                !this.order.precedes(reader, action),
        );
    }

    private conflictingChanges(
        changes: readonly ActionChange[],
        host: PlannerHost,
    ): PackageImportError[] {
        const byKey = new Map<string, ActionChange[]>();
        const errors: PackageImportError[] = [];

        for (const current of changes) {
            for (const previous of byKey.get(current.change.key) ?? []) {
                if (this.ordered(previous.action, current.action)) {
                    continue;
                }

                const issue = this.changeConflict(previous, current, host);

                if (issue) {
                    errors.push(issue);
                }
            }

            const previous = byKey.get(current.change.key) ?? [];
            previous.push(current);
            byKey.set(current.change.key, previous);
        }

        return errors;
    }

    private changeConflict(
        previous: ActionChange,
        current: ActionChange,
        host: PlannerHost,
    ): PackageImportError | undefined {
        const overlapping = [...current.change.properties].filter((name) =>
            previous.change.properties.has(name),
        );
        const conflicting = overlapping.filter(
            (name) =>
                !host.equal(
                    previous.change.after?.properties[name],
                    current.change.after?.properties[name],
                ),
        );
        const sharedAddition =
            this.sharedAdditions.has(current.change.key) &&
            previous.change.after !== undefined &&
            current.change.after !== undefined;

        if (
            (!sharedAddition && (previous.change.replacesItem || current.change.replacesItem)) ||
            conflicting.length > 0
        ) {
            const entry = current.change.after ?? current.change.before;

            return conflict(
                "AMBIGUOUS_IMPORT_ORDER",
                `Unordered changes to '${entry?.type}:${entry?.id}'${
                    conflicting.length ? ` properties ${conflicting.join(", ")}` : ""
                } produce different outcomes. Put dependent changes in an explicit XML sequence.`,
                current.action,
                previous.action,
            );
        }

        return undefined;
    }

    private optionalReadConflicts(
        attempts: ReadonlyMap<number, ImportAttempt>,
        changes: readonly ActionChange[],
    ): PackageImportError[] {
        const errors: PackageImportError[] = [];
        const index = new ImportCandidates(changes, this.initialEntries);

        for (const reader of this.actions) {
            for (const read of attempts.get(reader.id)?.reads ?? []) {
                if (read.kind !== "optional") {
                    continue;
                }

                for (const writer of index.changes(read)) {
                    if (this.ordered(reader, writer.action)) {
                        continue;
                    }

                    const issue = this.optionalReadConflict(reader, read, writer);

                    if (issue) {
                        errors.push(issue);
                    }
                }
            }
        }

        return errors;
    }

    private optionalReadConflict(
        reader: ImportAction,
        read: ImportRead,
        writer: ActionChange,
    ): PackageImportError | undefined {
        try {
            const before = writer.change.before ? read.matches(writer.change.before) : false;
            const after = writer.change.after ? read.matches(writer.change.after) : false;

            if (before !== after) {
                return conflict(
                    "AMBIGUOUS_IMPORT_ORDER",
                    "This delete can match different records depending on cross-file ordering. Put dependent changes in an explicit XML sequence.",
                    reader,
                    writer.action,
                );
            }
        } catch (error) {
            if (!(error instanceof PackageImportError)) {
                throw error;
            }

            return error;
        }

        return undefined;
    }

    private ordered(left: ImportAction, right: ImportAction): boolean {
        return (
            left.id === right.id ||
            this.order.precedes(left, right) ||
            this.order.precedes(right, left)
        );
    }

    private attemptErrors(attempts: ReadonlyMap<number, ImportAttempt>): PackageImportError[] {
        return [...attempts.values()].flatMap((attempt) => {
            const error = attempt.error;

            if (!error) {
                return [];
            }

            if (
                error.code === "DUPLICATE_ITEM" &&
                this.declarationErrors.some(
                    (declaration) =>
                        declaration.source.file === error.source.file &&
                        declaration.source.path === error.source.path,
                )
            ) {
                return [];
            }

            return [error];
        });
    }
}

function conflict(
    code: string,
    message: string,
    action: ImportAction,
    related: ImportAction,
): PackageImportError {
    const source = related.element.source;

    return new PackageImportError(
        code,
        `${message} Related action: ${source.file}:${source.line}:${source.column} ${source.path}.`,
        action.element.source,
        { relatedSources: [source] },
    );
}

function uniqueErrors(errors: readonly PackageImportError[]): PackageImportError[] {
    return [...new Map(errors.map((error) => [error.message, error])).values()];
}

function declaredAdditions(
    documents: readonly AmlDocument[],
    actions: readonly ImportAction[],
): ActionChange[] {
    const hashes = new Map(documents.map((document) => [document.file, document.sha256]));
    const declarations: ActionChange[] = [];

    for (const action of actions) {
        collectDeclaration(action.element, action, declarations, hashes);
    }

    return declarations;
}

function duplicateDeclarations(declarations: readonly ActionChange[]): PackageImportError[] {
    const seen = new Map<string, DraftEntry>();
    const errors: PackageImportError[] = [];

    for (const { action, change } of declarations) {
        const entry = change.after;

        if (action.fixture || !entry) {
            continue;
        }

        const existing = seen.get(change.key);

        if (
            existing &&
            existing.source.file !== entry.source.file &&
            !compatibleDeclarations(existing, entry)
        ) {
            const source = existing.source;
            errors.push(
                new PackageImportError(
                    "DUPLICATE_ITEM",
                    `Conflicting additions of '${entry.type}:${entry.id}'. Other declaration: ${source.file}:${source.line}:${source.column} ${source.path}.`,
                    entry.source,
                    { relatedSources: [source] },
                ),
            );
        } else {
            seen.set(change.key, entry);
        }
    }

    return errors;
}

function compatibleDeclarations(left: DraftEntry, right: DraftEntry): boolean {
    return Object.entries(left.properties).every(([name, value]) => {
        const other = getOwn(right.properties, name);

        return other === undefined || value === other;
    });
}

function sharedAdditions(
    declarations: readonly ActionChange[],
    initial: ReadonlyMap<string, DraftEntry>,
    work: WorkBudget,
): ReadonlySet<string> {
    const groups = new Map<string, DraftEntry[]>();

    for (const { action, change } of declarations) {
        if (action.fixture || !change.after) {
            continue;
        }

        const entries = groups.get(change.key) ?? [];
        entries.push(change.after);
        groups.set(change.key, entries);
    }

    const shared = new Set<string>();

    for (const [key, entries] of groups) {
        work.spend(entries.length * entries.length);

        if (initial.has(key) || new Set(entries.map((entry) => entry.source.file)).size < 2) {
            continue;
        }

        if (
            entries.every((entry) => entries.every((other) => compatibleDeclarations(entry, other)))
        ) {
            shared.add(key);
        }
    }

    return shared;
}

function collectDeclaration(
    element: AmlElement,
    action: ImportAction,
    declarations: ActionChange[],
    hashes: ReadonlyMap<string, string>,
    parent?: DraftEntry,
): void {
    const pending: { element: AmlElement; parent?: DraftEntry }[] = [
        { element, ...(parent ? { parent } : {}) },
    ];
    let visited = 0;

    while (pending.length > 0) {
        const frame = pending.pop();

        if (!frame) {
            throw new Error("A declaration frame must exist while traversal is pending.");
        }

        visited += 1;

        if (visited > dataNodesMax) {
            throw new PackageImportError(
                "INVALID_ITEM",
                "Too many nested declarations.",
                frame.element.source,
            );
        }

        const element = frame.element;
        const parent = frame.parent;

        if (element.name === "Item" && (element.attributes.action ?? "get") === "get") {
            continue;
        }

        const owner =
            element.name === "Item" ? declarationOwner(element, hashes, parent) : undefined;

        if (owner && element.attributes.action === "add") {
            declarations.push({
                action,
                change: {
                    key: entryKey(owner.type, owner.id),
                    before: undefined,
                    after: owner,
                    properties: new Set(Object.keys(owner.properties)),
                    replacesItem: true,
                    previousCreator: undefined,
                },
            });
        }

        const children = declarationChildren(element, owner);

        for (let index = children.length - 1; index >= 0; index -= 1) {
            const frame = children[index];

            if (frame) {
                pending.push(frame);
            }
        }
    }
}

function declarationOwner(
    element: AmlElement,
    hashes: ReadonlyMap<string, string>,
    parent?: DraftEntry,
): DraftEntry {
    const properties: Record<string, PendingValue> = {};

    for (const property of childElements(element)) {
        if (property.name === "Relationships") {
            continue;
        }

        const nested = childElements(property);

        if (property.attributes.is_null === "1") {
            setOwn(properties, property.name, null);
        } else if (nested.length === 0) {
            setOwn(properties, property.name, textContent(property));
        } else if (nested.length === 1 && nested[0]?.name === "Item" && nested[0].attributes.id) {
            setOwn(properties, property.name, nested[0].attributes.id);
        }
    }

    if (parent) {
        properties.source_id = parent.id;
    }

    return {
        id:
            element.attributes.id ??
            stableId(`package-item:${hashes.get(element.source.file)}:${element.source.path}`),
        type: itemType(element),
        attributes: element.attributes,
        properties,
        source: element.source,
    };
}

function declarationChildren(element: AmlElement, owner?: DraftEntry) {
    const children: { element: AmlElement; parent?: DraftEntry }[] = [];

    for (const child of childElements(element)) {
        if (child.name === "Relationships") {
            for (const relationship of childElements(child)) {
                children.push({ element: relationship, ...(owner ? { parent: owner } : {}) });
            }
        } else {
            children.push({ element: child });
        }
    }

    return children;
}
