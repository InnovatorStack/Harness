import { baselineTypeNames } from "../baseline/catalog.js";
import { isBaselineSource } from "../baseline/source.js";
import { getOwn, setOwn } from "../core/data.js";
import { errorMessage } from "../core/errors.js";
import type { SourceLocation } from "../diagnostics/source-location.js";
import type {
    CatalogEntry,
    HarnessStorage,
    StorageValue,
    ItemTypeDefinition,
} from "../storage/types.js";
import {
    bootstrapSource,
    presentationTypes,
    relationshipProperties,
    stableId,
    systemProperties,
    versionableProperties,
} from "./bootstrap.js";
import { PackageDefaults } from "./defaults.js";
import { PackageImportError, throwImportErrors } from "./diagnostics.js";
import { ImportDraft, entryKey } from "./draft.js";
import type { DraftEntry, PendingValue } from "./draft.js";
import { childElements, itemProperties, itemType, textContent, walkElements } from "./elements.js";
import { evaluateImport, ImportTask } from "./evaluation.js";
import type { ImportWork } from "./evaluation.js";
import { ImportPlan } from "./plan.js";
import type { ImportAction, ImportAttempt, ImportRead } from "./plan.js";
import {
    compileItemTypes,
    convertProperties,
    reusableItemTypes,
    validateReferences,
} from "./schema.js";
import { matchesImportValue, parseWhere } from "./selector.js";
import { readImportState } from "./state.js";
import type { AmlDocument, AmlElement } from "./types.js";

export interface PackageLoadReport {
    readonly documents: readonly {
        readonly path: string;
        readonly sha256: string;
    }[];
    readonly added: number;
    readonly updated: number;
    readonly deleted: number;
    readonly itemTypes: readonly string[];
    readonly generatedIds: readonly {
        readonly id: string;
        readonly source: SourceLocation;
    }[];
}

export class PackageImporter {
    private readonly draft: ImportDraft;
    private readonly defaults: PackageDefaults;
    private readonly generatedIds: { id: string; source: SourceLocation }[] = [];
    private readonly resolving = new Set<AmlElement>();
    private readonly documentHashes = new Map<string, string>();
    private addedCount = 0;
    private updatedCount = 0;
    private fixtureFiles: ReadonlySet<string> = new Set();
    private reads: ImportRead[] | undefined;
    private sharedAdditions: ReadonlySet<string> = new Set();

    constructor(private readonly storage: HarnessStorage) {
        this.draft = new ImportDraft(readImportState(storage));
        this.defaults = new PackageDefaults(this.draft);
    }

    import(
        documents: readonly AmlDocument[],
        fixtureFiles: ReadonlySet<string> = new Set(),
    ): PackageLoadReport {
        this.fixtureFiles = fixtureFiles;
        this.defaults.initialize();

        for (const document of documents) {
            this.documentHashes.set(document.file, document.sha256);
        }

        const initial = this.draft.checkpoint();
        const plan = new ImportPlan(documents, fixtureFiles, initial.entries);
        this.sharedAdditions = plan.sharedAdditions;
        const errors = [
            ...plan.execute({
                reset: () => {
                    this.draft.restore(initial);
                    this.addedCount = 0;
                    this.updatedCount = 0;
                    this.generatedIds.length = 0;
                },

                attempt: (action) => this.attemptAction(action),

                equal: (left, right) => {
                    if (left === undefined || right === undefined) {
                        return left === right;
                    }

                    try {
                        return this.resolveValue(left) === this.resolveValue(right);
                    } catch (error) {
                        if (!(error instanceof PackageImportError)) {
                            throw error;
                        }

                        return false;
                    }
                },
            }),
        ];
        const catalog = this.resolveCatalog(errors);
        throwImportErrors(errors);
        this.reconcileSystemProperties(catalog);
        this.completeSystemReferences(catalog);
        const definitions = this.defineItemTypes(catalog);

        this.persistCatalog(catalog);
        validateReferences(catalog, definitions, this.storage);

        return this.loadReport(documents, definitions);
    }

    private defineItemTypes(
        catalog: ReadonlyMap<string, CatalogEntry>,
    ): readonly ItemTypeDefinition[] {
        const reused = reusableItemTypes(
            catalog,
            this.draft.changed,
            this.draft.deleted.values(),
            this.storage,
        );

        if (reused) {
            return reused;
        }

        const definitions = compileItemTypes(catalog, this.storage);

        for (const definition of definitions) {
            this.withSource(definition.source ?? bootstrapSource("/"), () =>
                this.storage.defineItemType(definition),
            );
        }

        return definitions;
    }

    private loadReport(
        documents: readonly AmlDocument[],
        definitions: readonly ItemTypeDefinition[],
    ): PackageLoadReport {
        for (const document of documents) {
            this.storage.putDocument({
                path: document.file,
                sha256: document.sha256,
                xml: document.xml,
            });
        }

        return Object.freeze({
            documents: Object.freeze(
                documents.map(({ file, sha256 }) => Object.freeze({ path: file, sha256 })),
            ),
            added: this.addedCount,
            updated: this.updatedCount,
            deleted: this.draft.deleted.size,
            itemTypes: Object.freeze(definitions.map((definition) => definition.name)),
            generatedIds: Object.freeze(this.generatedIds.map((entry) => Object.freeze(entry))),
        });
    }

    private persistCatalog(catalog: ReadonlyMap<string, CatalogEntry>): void {
        for (const entry of this.draft.deleted.values()) {
            if (
                this.storage.getItemType(entry.type) &&
                this.storage.getItem(entry.type, entry.id)
            ) {
                this.storage.deleteItem(entry.type, entry.id);
            }

            this.storage.deleteCatalogEntry(entry.type, entry.id);
        }

        for (const key of this.draft.changed) {
            const entry = catalog.get(key);

            if (entry) {
                this.persistChangedEntry(entry, catalog);
            }
        }
    }

    private persistChangedEntry(
        entry: CatalogEntry,
        catalog: ReadonlyMap<string, CatalogEntry>,
    ): void {
        const definition = this.storage.getItemType(entry.type);

        if (!definition) {
            const metadata = [...catalog.values()].find(
                (candidate) =>
                    candidate.type === "ItemType" && candidate.properties.name === entry.type,
            );

            if (metadata && metadata.properties.implementation_type !== "table") {
                throw new PackageImportError(
                    "UNSUPPORTED_IMPLEMENTATION",
                    `Records of '${entry.type}' use '${metadata.properties.implementation_type}' storage and require an adapter.`,
                    entry.source,
                );
            }

            throw new PackageImportError(
                "MISSING_ITEM_TYPE",
                `No ItemType definition for '${entry.type}'. Supply its package explicitly.`,
                entry.source,
                { reference: { type: "ItemType", name: entry.type } },
            );
        }

        this.withSource(entry.source, () => {
            const properties = convertProperties(entry, definition);
            const existing = this.storage.getItem(entry.type, entry.id);

            if (existing) {
                this.storage.updateItem(entry.type, entry.id, properties);
            } else {
                if (definition.isVersionable) {
                    const defaults = { config_id: entry.id, generation: 1, is_current: 1 };

                    for (const [name, value] of Object.entries(defaults)) {
                        if (properties[name] === undefined) {
                            setOwn(properties, name, value);
                        }
                    }
                }

                this.storage.insertItem({
                    id: entry.id,
                    type: entry.type,
                    properties,
                });
            }

            this.storage.putCatalogEntry({ ...entry, properties });
        });
    }

    private importAction(element: AmlElement): string {
        const type = itemType(element);

        if (textContent(element).trim()) {
            throw new PackageImportError(
                "INVALID_ITEM_TEXT",
                "An Item may only contain property elements, Relationships, and whitespace.",
                element.source,
            );
        }

        let action = element.attributes.action ?? "get";

        if (this.fixtureFiles.has(element.source.file)) {
            if (
                [
                    "ItemType",
                    "Property",
                    "RelationshipType",
                    "Server Event",
                    "Method",
                    "SQL",
                    "ItemType Life Cycle",
                    "Life Cycle Map",
                    "Life Cycle State",
                    "Life Cycle Transition",
                ].includes(type)
            ) {
                throw new PackageImportError(
                    "FIXTURE_DEFINITION",
                    `Fixture files contain starting data. Put '${type}' definitions in packages.`,
                    element.source,
                );
            }

            if (
                action === "add" &&
                element.attributes.id &&
                this.draft.entries.has(entryKey(type, element.attributes.id))
            ) {
                action = "edit";
            }
        }

        for (const attribute of ["idlist", "condition", "levels", "queryType"]) {
            if (element.attributes[attribute] !== undefined) {
                throw new PackageImportError(
                    "UNSUPPORTED_SELECTOR",
                    `Item attribute '${attribute}' is not supported by package loading.`,
                    element.source,
                );
            }
        }

        return action;
    }

    private attemptAction(action: ImportAction): ImportAttempt {
        const added = this.addedCount;
        const updated = this.updatedCount;
        const generated = this.generatedIds.length;
        const reads: ImportRead[] = [];
        this.reads = reads;
        this.draft.begin(action.id);

        try {
            evaluateImport(new ImportTask(this.applyItemSteps(action.element)));
            const changes = this.draft.changes();
            this.draft.commit();

            return { reads, changes };
        } catch (error) {
            const changes = this.draft.changes();
            this.draft.rollback();
            this.addedCount = added;
            this.updatedCount = updated;
            this.generatedIds.length = generated;

            if (!(error instanceof PackageImportError)) {
                throw error;
            }

            return { reads, changes, error };
        } finally {
            this.reads = undefined;
        }
    }

    private *applyItemSteps(
        element: AmlElement,
        parent?: DraftEntry,
    ): Generator<ImportWork, string, void> {
        const type = itemType(element);
        const action = this.importAction(element);

        if (action === "get") {
            const selected = new ImportTask(this.selectOneSteps(element, true, parent));
            yield selected;

            return selected.value().id;
        }

        if (action === "delete") {
            const deletion = new ImportTask(this.deleteItemSteps(element, type, parent));
            yield deletion;

            return deletion.value();
        }

        if (action !== "add" && action !== "edit") {
            throw new PackageImportError(
                "UNSUPPORTED_IMPORT_ACTION",
                `Import action '${action}' is not implemented. Package loading never executes Methods or platform events.`,
                element.source,
            );
        }

        const prepared = new ImportTask(this.prepareEntrySteps(element, type, action, parent));
        yield prepared;
        const { entry, repeatedAddition } = prepared.value();
        yield new ImportTask(this.applyPropertiesSteps(element, entry, repeatedAddition, parent));

        if (type === "Property" && action === "add") {
            this.defaults.replaceProperty(entry);
            this.replaceGeneratedProperty(entry);
        }

        if (type === "ItemType") {
            this.addSystemProperties(entry);
        }

        for (const relationships of childElements(element).filter(
            (child) => child.name === "Relationships",
        )) {
            if (textContent(relationships).trim()) {
                throw new PackageImportError(
                    "INVALID_RELATIONSHIPS",
                    "Relationships may only contain Items and whitespace.",
                    relationships.source,
                );
            }

            for (const relationship of childElements(relationships)) {
                yield new ImportTask(this.applyItemSteps(relationship, entry));
            }
        }

        return entry.id;
    }

    private *deleteItemSteps(
        element: AmlElement,
        type: string,
        parent?: DraftEntry,
    ): Generator<ImportWork, string, void> {
        if (childElements(element).length) {
            throw new PackageImportError(
                "UNSUPPORTED_SELECTOR",
                "Delete actions accept only an ID or where selector; child elements are not implemented.",
                element.source,
            );
        }

        if (type === "ItemType" || type === "Property") {
            throw new PackageImportError(
                "UNSUPPORTED_SCHEMA_CHANGE",
                "Deleting ItemTypes or Properties requires a schema migration implementation.",
                element.source,
            );
        }

        const selection = new ImportTask(this.selectSteps(element, false, parent, "optional"));
        yield selection;
        const matches = selection.value();

        // Export installers also remove generated forms/views that may not exist locally.
        // A declarative delete is satisfied when no matching record remains.
        for (const entry of matches) {
            const key = entryKey(type, entry.id);
            this.draft.remove(key, entry);
        }

        return matches[0]?.id ?? "";
    }

    private *prepareEntrySteps(
        element: AmlElement,
        type: string,
        action: string,
        parent?: DraftEntry,
    ): Generator<ImportWork, { entry: DraftEntry; repeatedAddition: boolean }, void> {
        if (action === "add") {
            return this.addEntry(element, type);
        }

        const selection = new ImportTask(this.selectOneSteps(element, false, parent));
        yield selection;
        this.updatedCount += 1;

        return { entry: selection.value(), repeatedAddition: false };
    }

    private addEntry(
        element: AmlElement,
        type: string,
    ): { entry: DraftEntry; repeatedAddition: boolean } {
        if (element.attributes.where !== undefined) {
            throw new PackageImportError(
                "UNSUPPORTED_SELECTOR",
                "An add action cannot contain a where selector.",
                element.source,
            );
        }

        const suppliedId = element.attributes.id;
        const documentHash = this.documentHashes.get(element.source.file);
        const id = suppliedId ?? stableId(`package-item:${documentHash}:${element.source.path}`);

        if (id.trim().length === 0) {
            throw new PackageImportError("INVALID_ID", "Item ID cannot be empty.", element.source);
        }

        const key = entryKey(type, id);
        const existing = this.draft.entries.get(key);
        const replacingDefault = existing && isBaselineSource(existing.source);
        const repeatedAddition = Boolean(
            existing &&
            this.sharedAdditions.has(key) &&
            existing.source.file !== element.source.file,
        );

        if (!replacingDefault && !repeatedAddition) {
            this.reads?.push({
                kind: "absent",
                key,
                type,
                source: element.source,
                matchedKeys: existing ? [key] : [],

                matches: (candidate) => entryKey(candidate.type, candidate.id) === key,
            });
        }

        if (existing && !replacingDefault && !repeatedAddition) {
            throw new PackageImportError(
                "DUPLICATE_ITEM",
                `An item of type '${type}' with ID '${id}' already exists at ${existing.source.file}:${existing.source.line}:${existing.source.column}. Use edit for patches.`,
                element.source,
                { relatedSources: [existing.source] },
            );
        }

        const entry =
            existing && repeatedAddition
                ? existing
                : {
                      id,
                      type,
                      attributes: element.attributes,
                      properties: replacingDefault ? { ...existing.properties } : {},
                      source: element.source,
                  };

        this.replaceDefaultItemType(element, type, id);

        this.recordAddition(entry, repeatedAddition, suppliedId === undefined);

        return { entry, repeatedAddition };
    }

    private recordAddition(entry: DraftEntry, repeatedAddition: boolean, generated: boolean): void {
        if (!repeatedAddition) {
            this.draft.put(entry);
            this.addedCount += 1;
        }

        if (generated) {
            this.generatedIds.push({ id: entry.id, source: entry.source });
        }
    }

    private replaceDefaultItemType(element: AmlElement, type: string, id: string): void {
        if (type === "ItemType") {
            const name = itemProperties(element).find((property) => property.name === "name");

            if (name) {
                this.defaults.replaceItemType(textContent(name), id);
            }
        }
    }

    private *applyPropertiesSteps(
        element: AmlElement,
        entry: DraftEntry,
        repeatedAddition: boolean,
        parent?: DraftEntry,
    ): Generator<ImportWork, void, void> {
        const properties = itemProperties(element);
        this.draft.touch(
            entry,
            properties.map((property) => property.name),
        );

        for (const property of properties) {
            const task = new ImportTask(
                this.importPropertySteps(property, entry, repeatedAddition),
            );
            yield task;
            setOwn(entry.properties, property.name, task.value());
        }

        if (parent) {
            this.draft.touch(entry, ["source_id"]);
            const sourceId = getOwn(entry.properties, "source_id");

            if (sourceId !== undefined) {
                const resolved = new ImportTask(this.resolveValueSteps(sourceId));
                yield resolved;

                if (String(resolved.value()).toLowerCase() !== parent.id.toLowerCase()) {
                    throw new PackageImportError(
                        "RELATIONSHIP_SOURCE_MISMATCH",
                        "A nested relationship's source_id must identify its parent.",
                        element.source,
                    );
                }
            }

            entry.properties.source_id = parent.id;
        }

        if (!repeatedAddition) {
            entry.attributes = element.attributes;
            entry.source = element.source;
        }
    }

    private *importPropertySteps(
        property: AmlElement,
        entry: DraftEntry,
        repeatedAddition: boolean,
    ): Generator<ImportWork, PendingValue, void> {
        // A family identity does not require the first generation to be present.
        let value: PendingValue;

        if (property.name === "config_id" && childElements(property).length === 0) {
            value = textContent(property).trim() || null;
        } else {
            const propertyValue = new ImportTask(
                this.propertyValueSteps(property, presentationTypes.has(entry.type)),
            );
            yield propertyValue;
            value = propertyValue.value();
        }

        const previous = getOwn(entry.properties, property.name);

        if (repeatedAddition && previous !== undefined) {
            const before = new ImportTask(this.resolveValueSteps(previous));
            yield before;
            const after = new ImportTask(this.resolveValueSteps(value));
            yield after;

            if (before.value() !== after.value()) {
                throw new PackageImportError(
                    "DUPLICATE_ITEM",
                    `Repeated addition of '${entry.type}:${entry.id}' conflicts on '${property.name}'.`,
                    property.source,
                    { relatedSources: [entry.source] },
                );
            }
        }

        return value;
    }

    private replaceGeneratedProperty(entry: DraftEntry): void {
        const owner = entry.properties.source_id;
        const name = entry.properties.name;

        if (typeof owner !== "string" || typeof name !== "string") {
            return;
        }

        const generatedId = stableId(`system-property-v1:${owner}:${name}`);

        if (entry.id === generatedId) {
            return;
        }

        const key = entryKey("Property", generatedId);

        if (this.draft.entries.has(key)) {
            const stored = this.storage.getCatalogEntry("Property", generatedId);
            this.draft.remove(
                key,
                stored ? { ...stored, properties: { ...stored.properties } } : undefined,
            );
        }
    }

    private reconcileSystemProperties(catalog: Map<string, CatalogEntry>): void {
        for (const entry of catalog.values()) {
            const owner = entry.properties.source_id;
            const name = entry.properties.name;

            if (
                entry.type !== "Property" ||
                typeof owner !== "string" ||
                typeof name !== "string"
            ) {
                continue;
            }

            const generatedId = stableId(`system-property-v1:${owner}:${name}`);

            if (entry.id === generatedId) {
                continue;
            }

            const key = entryKey("Property", generatedId);
            const generated = catalog.get(key);

            if (generated) {
                catalog.delete(key);
                const stored = this.storage.getCatalogEntry("Property", generatedId);
                this.draft.remove(
                    key,
                    stored ? { ...generated, properties: { ...generated.properties } } : undefined,
                );
            }
        }
    }

    private addSystemProperties(entry: DraftEntry): void {
        const properties = [...systemProperties];

        if (entry.properties.is_versionable === "1" || entry.properties.is_versionable === 1) {
            properties.push(...versionableProperties);
        }

        if (entry.properties.is_relationship === "1") {
            properties.push(...relationshipProperties);
        }

        const existing = new Set(
            [...this.draft.ofType("Property")]
                .filter((candidate) => candidate.properties.source_id === entry.id)
                .map((candidate) => candidate.properties.name),
        );

        for (const property of properties) {
            if (existing.has(property.name)) {
                continue;
            }

            const id = stableId(`system-property-v1:${entry.id}:${property.name}`);
            this.draft.put({
                id,
                type: "Property",
                attributes: {},
                source: entry.source,
                properties: {
                    name: property.name,
                    data_type: property.dataType,
                    source_id: entry.id,
                },
            });
            existing.add(property.name);
        }
    }

    private completeSystemReferences(catalog: Map<string, CatalogEntry>): void {
        const user = [...catalog.values()].find(
            (entry) =>
                entry.type === "ItemType" && String(entry.properties.name).toLowerCase() === "user",
        );

        if (!user) {
            return;
        }

        for (const entry of catalog.values()) {
            const owner = entry.properties.source_id;

            if (
                entry.type !== "Property" ||
                entry.properties.name !== "locked_by_id" ||
                entry.properties.data_type !== "item" ||
                entry.properties.data_source === user.id ||
                typeof owner !== "string" ||
                entry.id !== stableId(`system-property-v1:${owner}:locked_by_id`)
            ) {
                continue;
            }

            const updated = { ...entry, properties: { ...entry.properties, data_source: user.id } };
            this.draft.put({ ...updated, properties: { ...updated.properties } });
            catalog.set(entryKey(entry.type, entry.id), updated);
        }
    }

    private *propertyValueSteps(
        property: AmlElement,
        opaque = false,
    ): Generator<ImportWork, PendingValue, void> {
        const children = childElements(property);
        const value = textContent(property);
        const nullAttribute = validatePropertyAttributes(property);

        if (nullAttribute === "1") {
            if (children.length || value.trim()) {
                throw new PackageImportError(
                    "INVALID_NULL",
                    "A null property cannot also contain a value.",
                    property.source,
                );
            }

            return null;
        }

        if (children.length > 0) {
            const child = children[0];

            if (children.length !== 1 || child?.name !== "Item" || value.trim()) {
                throw new PackageImportError(
                    "UNSUPPORTED_PROPERTY_MARKUP",
                    "A property may contain text or one nested Item reference.",
                    property.source,
                );
            }

            if ((child.attributes.action ?? "get") === "get") {
                if (opaque && child.attributes.id) {
                    return child.attributes.id;
                }

                return { kind: "reference", element: child };
            }

            const nested = new ImportTask(this.applyItemSteps(child));
            yield nested;
            const id = nested.value();

            return {
                kind: "typed-reference",
                type: itemType(child),
                id,
                source: child.source,
            };
        }

        const referencedType = property.attributes.type;

        if (referencedType && value.trim()) {
            if (opaque || presentationTypes.has(referencedType)) {
                return value.trim();
            }

            return {
                kind: "typed-reference",
                type: referencedType,
                id: value.trim(),
                source: property.source,
            };
        }

        return value;
    }

    private *selectSteps(
        element: AmlElement,
        useProperties: boolean,
        parent?: DraftEntry,
        kind: ImportRead["kind"] = "unique",
    ): Generator<ImportWork, DraftEntry[], void> {
        const type = itemType(element);
        this.validateSelector(element, useProperties);
        const id = element.attributes.id;
        const filters: { name: string; value: StorageValue }[] = [...parseWhere(element)];
        const properties = useProperties ? itemProperties(element) : [];

        for (const property of properties) {
            const value = new ImportTask(this.selectorValueSteps(property));
            yield value;
            filters.push({ name: property.name, value: value.value() });
        }

        if (id === undefined && filters.length === 0 && properties.length === 0) {
            throw new PackageImportError(
                "UNBOUNDED_SELECTOR",
                "An import selector needs an ID, equality properties, or a supported where clause.",
                element.source,
            );
        }

        const dataTypes = new Map(
            filters.map(({ name }) => [name, this.propertyDataType(type, name)]),
        );
        const matchedKeys: string[] = [];
        this.reads?.push({
            kind,
            type,
            ...(id !== undefined ? { key: entryKey(type, id) } : {}),
            source: element.source,
            matchedKeys,

            // The planner invokes this later, after the current interpreter has completed.
            matches: (entry) => {
                const result = this.matchEntry(entry, type, id, parent, filters, dataTypes);

                return result instanceof ImportTask ? evaluateImport(result) : result;
            },
        });
        const selected: DraftEntry[] = [];

        const entries =
            id === undefined
                ? this.draft.ofType(type)
                : [this.draft.entries.get(entryKey(type, id))];

        for (const entry of entries) {
            if (!entry) {
                continue;
            }

            const match = this.matchEntry(entry, type, id, parent, filters, dataTypes);

            if (match instanceof ImportTask) {
                yield match;
            }

            if (match instanceof ImportTask ? match.value() : match) {
                selected.push(entry);
                matchedKeys.push(entryKey(entry.type, entry.id));
            }
        }

        return selected;
    }

    private matchEntry(
        entry: DraftEntry,
        type: string,
        id: string | undefined,
        parent: DraftEntry | undefined,
        predicates: readonly { name: string; value: StorageValue }[],
        dataTypes: ReadonlyMap<string, string | undefined>,
    ): boolean | ImportTask<boolean> {
        if (
            entry.type.toLowerCase() !== type.toLowerCase() ||
            (id !== undefined && entry.id.toLowerCase() !== id.toLowerCase())
        ) {
            return false;
        }

        const criteria = parent
            ? [{ name: "source_id", value: parent.id }, ...predicates]
            : predicates;

        for (const { name, value } of criteria) {
            const actual = this.lookupProperty(entry, name);

            if (actual !== null && typeof actual === "object") {
                return new ImportTask(
                    this.matchesEntrySteps(entry, type, id, parent, predicates, dataTypes),
                );
            }

            if (parent && name === "source_id" && actual !== parent.id) {
                return false;
            }

            if (!matchesImportValue(actual, value, name, dataTypes.get(name))) {
                return false;
            }
        }

        return true;
    }

    private *matchesEntrySteps(
        entry: DraftEntry,
        type: string,
        id: string | undefined,
        parent: DraftEntry | undefined,
        predicates: readonly { name: string; value: StorageValue }[],
        dataTypes: ReadonlyMap<string, string | undefined>,
    ): Generator<ImportWork, boolean, void> {
        if (
            entry.type.toLowerCase() !== type.toLowerCase() ||
            (id !== undefined && entry.id.toLowerCase() !== id.toLowerCase())
        ) {
            return false;
        }

        if (parent) {
            const sourceId = new ImportTask(this.lookupPropertySteps(entry, "source_id"));
            yield sourceId;

            if (sourceId.value() !== parent.id) {
                return false;
            }
        }

        for (const { name, value } of predicates) {
            const actual = new ImportTask(this.lookupPropertySteps(entry, name));
            yield actual;

            if (!matchesImportValue(actual.value(), value, name, dataTypes.get(name))) {
                return false;
            }
        }

        return true;
    }

    private validateSelector(element: AmlElement, useProperties: boolean): void {
        for (const attribute of ["idlist", "condition", "levels", "queryType"]) {
            if (element.attributes[attribute] !== undefined) {
                throw new PackageImportError(
                    "UNSUPPORTED_SELECTOR",
                    `Item attribute '${attribute}' is not supported by package loading.`,
                    element.source,
                );
            }
        }

        if (
            useProperties &&
            childElements(element).some((child) => child.name === "Relationships")
        ) {
            throw new PackageImportError(
                "UNSUPPORTED_SELECTOR",
                "Relationship queries are not implemented in package get selectors.",
                element.source,
            );
        }
    }

    private propertyDataType(type: string, name: string): string | undefined {
        let dataType =
            this.storage.getItemType(type)?.properties.find((property) => property.name === name)
                ?.dataType ?? systemProperties.find((property) => property.name === name)?.dataType;
        const owner = [...this.draft.ofType("ItemType")].find(
            (candidate) =>
                candidate.type === "ItemType" &&
                (typeof candidate.properties.name === "string"
                    ? candidate.properties.name
                    : ""
                ).toLowerCase() === type.toLowerCase(),
        );

        if (owner) {
            const property = [...this.draft.ofType("Property")].find(
                (candidate) =>
                    candidate.type === "Property" &&
                    candidate.properties.name === name &&
                    typeof candidate.properties.source_id === "string" &&
                    candidate.properties.source_id.toLowerCase() === owner.id.toLowerCase(),
            );

            if (typeof property?.properties.data_type === "string") {
                dataType = property.properties.data_type;
            }
        }

        return dataType;
    }

    private *selectorValueSteps(property: AmlElement): Generator<ImportWork, StorageValue, void> {
        for (const element of walkElements([property])) {
            if (element.name === "Item" && (element.attributes.action ?? "get") !== "get") {
                throw new PackageImportError(
                    "UNSUPPORTED_SELECTOR",
                    "Nested Items in selectors must use the get action.",
                    element.source,
                );
            }
        }

        const value = new ImportTask(this.propertyValueSteps(property));
        yield value;
        const resolved = new ImportTask(this.resolveValueSteps(value.value()));
        yield resolved;

        return resolved.value();
    }

    private *selectOneSteps(
        element: AmlElement,
        useProperties = true,
        parent?: DraftEntry,
    ): Generator<ImportWork, DraftEntry, void> {
        const selection = new ImportTask(this.selectSteps(element, useProperties, parent));
        yield selection;
        const matches = selection.value();

        if (matches.length === 0) {
            return this.noMatch(element);
        }

        if (matches.length !== 1) {
            const candidates = matches
                .map((entry) => `${entry.id} at ${entry.source.file}:${entry.source.line}`)
                .join(", ");

            throw new PackageImportError(
                "AMBIGUOUS_REFERENCE",
                `Selector for '${itemType(element)}' matched ${matches.length} items; expected one. ` +
                    `Candidates: ${candidates}.`,
                element.source,
                {
                    relatedSources: matches.map((entry) => entry.source),
                    reference: { type: itemType(element), selector: element },
                },
            );
        }

        const match = matches[0];

        if (!match) {
            return this.noMatch(element);
        }

        return match;
    }

    private noMatch(element: AmlElement): never {
        throw new PackageImportError(
            "MISSING_REFERENCE",
            `No '${itemType(element)}' matches this selector. Supply the required package or fixture explicitly.`,
            element.source,
            { reference: { type: itemType(element), selector: element } },
        );
    }

    private *lookupPropertySteps(
        entry: DraftEntry,
        name: string,
    ): Generator<ImportWork, StorageValue | undefined, void> {
        const value = this.lookupProperty(entry, name);

        if (value === undefined || value === null || typeof value !== "object") {
            return value;
        }

        const resolved = new ImportTask(this.resolveValueSteps(value));
        yield resolved;

        return resolved.value();
    }

    private lookupProperty(entry: DraftEntry, name: string): PendingValue | undefined {
        if (name === "id") {
            return entry.id;
        }

        let value = getOwn(entry.properties, name);

        if (value === undefined && name === "keyed_name" && baselineTypeNames.has(entry.type)) {
            value = getOwn(entry.properties, "name");
        }

        // Selector matching compares typed IDs before final target-existence validation.
        if (value !== null && typeof value === "object" && value.kind === "typed-reference") {
            return value.id;
        }

        return value;
    }

    private resolveValue(value: PendingValue): StorageValue {
        if (value === null || typeof value !== "object") {
            return value;
        }

        return evaluateImport(new ImportTask(this.resolveValueSteps(value)));
    }

    private *resolveValueSteps(value: PendingValue): Generator<ImportWork, StorageValue, void> {
        if (value === null || typeof value !== "object") {
            return value;
        }

        if (value.kind === "typed-reference") {
            const key = entryKey(value.type, value.id);
            this.reads?.push({
                kind: "unique",
                key,
                type: value.type,
                source: value.source,
                matchedKeys: this.draft.entries.has(key) ? [key] : [],

                matches: (entry) => entryKey(entry.type, entry.id) === key,
            });

            if (!this.draft.entries.has(key)) {
                throw new PackageImportError(
                    "MISSING_REFERENCE",
                    `Missing '${value.type}' with ID '${value.id}'. Supply the required package or fixture explicitly.`,
                    value.source,
                    { reference: { type: value.type, id: value.id } },
                );
            }

            return value.id;
        }

        if (this.resolving.has(value.element)) {
            throw new PackageImportError(
                "CYCLIC_SELECTOR",
                "Nested get selectors form an unresolved cycle.",
                value.element.source,
            );
        }

        this.resolving.add(value.element);

        try {
            const selection = new ImportTask(this.selectOneSteps(value.element));
            yield selection;

            return selection.value().id;
        } finally {
            this.resolving.delete(value.element);
        }
    }

    private resolveCatalog(errors: PackageImportError[]): Map<string, CatalogEntry> {
        const catalog = new Map<string, CatalogEntry>();

        for (const [key, entry] of this.draft.entries) {
            const properties: Record<string, StorageValue> = {};

            for (const [name, value] of Object.entries(entry.properties)) {
                try {
                    setOwn(properties, name, this.resolveValue(value));
                } catch (error) {
                    if (!(error instanceof PackageImportError)) {
                        throw error;
                    }

                    errors.push(error);
                }
            }

            catalog.set(key, { ...entry, properties });
        }

        return catalog;
    }

    private withSource<T>(source: SourceLocation, action: () => T): T {
        try {
            return action();
        } catch (error) {
            if (error instanceof PackageImportError) {
                throw error;
            }

            throw new PackageImportError("STORAGE_IMPORT_FAILED", errorMessage(error), source, {
                cause: error,
            });
        }
    }
}

function validatePropertyAttributes(property: AmlElement): string | undefined {
    const nullAttribute = property.attributes.is_null;

    if (nullAttribute !== undefined && nullAttribute !== "0" && nullAttribute !== "1") {
        throw new PackageImportError(
            "INVALID_NULL",
            "is_null must be '0' or '1'.",
            property.source,
        );
    }

    for (const name of ["condition", "date_range", "is_not_null"]) {
        if (property.attributes[name] !== undefined) {
            throw new PackageImportError(
                "UNSUPPORTED_PROPERTY_ATTRIBUTE",
                `Property attribute '${name}' is not implemented.`,
                property.source,
            );
        }
    }

    return nullAttribute;
}
