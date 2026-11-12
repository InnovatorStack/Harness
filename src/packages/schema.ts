import { baselineTypeNames } from "../baseline/catalog.js";
import { getOwn, setOwn } from "../core/data.js";
import { metadataEpoch } from "../storage/metadata-epoch.js";
import type {
    CatalogEntry,
    HarnessStorage,
    ItemTypeDefinition,
    PropertyDefinition,
    StoredItem,
    StorageValue,
} from "../storage/types.js";
import {
    bootstrapSource,
    presentationTypes,
    relationshipProperties,
    systemProperties,
    versionableProperties,
} from "./bootstrap.js";
import { PackageImportError, throwImportErrors } from "./diagnostics.js";

function stringProperty(entry: CatalogEntry, name: string): string | undefined {
    const value = getOwn(entry.properties, name);

    if (typeof value === "string") {
        return value;
    }

    return undefined;
}

const schemaTypes = new Set(["itemtype", "property", "relationshiptype"]);

/** Data and Method imports need reference validation, but do not redefine unchanged tables. */
export function reusableItemTypes(
    catalog: ReadonlyMap<string, CatalogEntry>,
    changed: ReadonlySet<string>,
    deleted: Iterable<{ readonly type: string }>,
    storage: HarnessStorage,
): ItemTypeDefinition[] | undefined {
    if (metadataEpoch(storage) === undefined) {
        return undefined;
    }

    for (const key of changed) {
        const entry = catalog.get(key);

        if (
            schemaTypes.has(entry?.type.toLowerCase() ?? "") ||
            needsBaselineProperties(entry, storage)
        ) {
            return undefined;
        }
    }

    for (const entry of deleted) {
        if (schemaTypes.has(entry.type.toLowerCase())) {
            return undefined;
        }
    }

    const definitions: ItemTypeDefinition[] = [];

    for (const type of catalog.values()) {
        if (type.type !== "ItemType") {
            continue;
        }

        const implementation = stringProperty(type, "implementation_type");

        if (implementation === "polymorphic" || implementation === "federated") {
            continue;
        }

        const name = stringProperty(type, "name");
        const definition = name ? storage.getItemType(name) : undefined;

        if (
            !definition ||
            definition.id !== type.id ||
            (implementation !== undefined && implementation !== "table")
        ) {
            return undefined;
        }

        definitions.push(definition);
    }

    return definitions;
}

function needsBaselineProperties(
    entry: CatalogEntry | undefined,
    storage: HarnessStorage,
): boolean {
    if (!entry || !baselineTypeNames.has(entry.type)) {
        return false;
    }

    const definition = storage.getItemType(entry.type);

    if (!definition) {
        return true;
    }

    const names = new Set(definition.properties.map((property) => property.name));

    return Object.keys(entry.properties).some((name) => name !== "id" && !names.has(name));
}

export function compileItemTypes(
    catalog: ReadonlyMap<string, CatalogEntry>,
    storage: HarnessStorage,
): ItemTypeDefinition[] {
    const entries = [...catalog.values()];
    const types = entries.filter((entry) => entry.type === "ItemType");
    const declaredProperties = entries.filter((entry) => entry.type === "Property");
    const propertiesByOwner = new Map<string, CatalogEntry[]>();

    for (const property of declaredProperties) {
        const owner = stringProperty(property, "source_id")?.toLowerCase() ?? "";
        const owned = propertiesByOwner.get(owner) ?? [];
        owned.push(property);
        propertiesByOwner.set(owner, owned);
    }

    validateDefinitions(types, declaredProperties);
    const definitions: ItemTypeDefinition[] = [];

    for (const type of types) {
        const name = stringProperty(type, "name");

        if (!name) {
            throw new PackageImportError(
                "INVALID_ITEM_TYPE",
                "ItemType requires a name.",
                type.source,
            );
        }

        const implementation = stringProperty(type, "implementation_type");

        if (implementation && implementation !== "table") {
            // A stored definition does not imply an implementation of its storage.
            // Runtime access is checked separately by the platform catalog.
            if (implementation === "polymorphic" || implementation === "federated") {
                continue;
            }

            throw new PackageImportError(
                "UNSUPPORTED_IMPLEMENTATION",
                `ItemType implementation '${implementation}' requires an adapter.`,
                type.source,
            );
        }

        const properties = compileProperties(
            type,
            propertiesByOwner.get(type.id.toLowerCase()) ?? [],
        );
        supplementBaselineProperties(name, entries, storage, properties);
        compileRelationshipProperties(type, entries, properties);

        const tableName = stringProperty(type, "instance_data");
        definitions.push({
            id: type.id,
            name,
            properties: [...properties.values()],
            isRelationship:
                type.properties.is_relationship === "1" || type.properties.is_relationship === 1,
            isVersionable: String(type.properties.is_versionable ?? "0") === "1",
            ...(tableName ? { tableName } : {}),
            source: type.source,
        });
    }

    return definitions;
}

function validateDefinitions(
    types: readonly CatalogEntry[],
    properties: readonly CatalogEntry[],
): void {
    const errors: PackageImportError[] = [];
    const typeIds = new Set(types.map((type) => type.id.toLowerCase()));
    validateTypeNames(types, errors);

    const propertyNames = new Map<string, CatalogEntry>();

    for (const property of properties) {
        const owner = stringProperty(property, "source_id");
        const name = stringProperty(property, "name");

        if (!owner || !typeIds.has(owner.toLowerCase())) {
            errors.push(
                new PackageImportError(
                    "MISSING_PROPERTY_OWNER",
                    `Property '${name ?? property.id}' references missing ItemType '${owner ?? ""}' in source_id.`,
                    property.source,
                    { reference: { type: "ItemType", ...(owner ? { id: owner } : {}) } },
                ),
            );
        }

        if (!name || !stringProperty(property, "data_type")) {
            errors.push(
                new PackageImportError(
                    "INVALID_PROPERTY",
                    "Property requires name and data_type.",
                    property.source,
                ),
            );
            continue;
        }

        const key = JSON.stringify([owner?.toLowerCase(), name.toLowerCase()]);
        const existing = propertyNames.get(key);

        if (owner && existing) {
            errors.push(
                new PackageImportError(
                    "DUPLICATE_PROPERTY",
                    `Property '${owner}.${name}' is declared more than once. Other definition: ${existing.source.file}:${existing.source.line}.`,
                    property.source,
                    { relatedSources: [existing.source] },
                ),
            );
        } else {
            propertyNames.set(key, property);
        }
    }

    throwImportErrors(errors);
}

export function convertProperties(
    entry: CatalogEntry,
    definition: ItemTypeDefinition,
): Record<string, StorageValue> {
    const properties: Record<string, StorageValue> = {};

    for (const [name, value] of Object.entries(entry.properties)) {
        if (name === "id") {
            if (value !== entry.id) {
                throw new PackageImportError(
                    "ID_MISMATCH",
                    "The id property conflicts with the Item's id attribute.",
                    entry.source,
                );
            }

            continue;
        }

        const property = definition.properties.find((property) => property.name === name);

        if (!property && name !== "source_id" && name !== "related_id") {
            throw new PackageImportError(
                "UNKNOWN_PROPERTY",
                `No Property definition for '${entry.type}.${name}'. Supply the required metadata.`,
                entry.source,
            );
        }

        // Exported calculated values remain in the source document; reads derive them from
        // stored data.
        if (property?.dataType === "foreign" || property?.isFederated) {
            continue;
        }

        setOwn(properties, name, convertValue(entry, name, value, property));
    }

    return properties;
}

export function validateReferences(
    catalog: ReadonlyMap<string, CatalogEntry>,
    definitions: readonly ItemTypeDefinition[],
    storage: HarnessStorage,
): void {
    const errors: PackageImportError[] = [];
    const types = new Map(
        definitions.map((definition) => [definition.id.toLowerCase(), definition]),
    );
    const names = new Map(
        definitions.map((definition) => [definition.name.toLowerCase(), definition]),
    );
    const rows = new Map(
        definitions.map((definition) => [definition.name, storage.listItems(definition.name)]),
    );
    const targets = new Map(
        [...rows].map(([name, items]) => [
            name,
            new Set(items.map((item) => item.id.toLowerCase())),
        ]),
    );

    for (const definition of definitions) {
        if (presentationTypes.has(definition.name)) {
            continue;
        }

        const items = rows.get(definition.name) ?? [];

        for (const property of definition.properties) {
            if (property.dataType !== "item" || !property.dataSource) {
                continue;
            }

            const target = types.get(property.dataSource.toLowerCase());

            if (!target) {
                missingTarget(catalog, definition, property, property.dataSource, items, errors);
                continue;
            }

            if (property.name === "config_id" && target.id === definition.id) {
                continue;
            }

            validatePropertyReferences(
                catalog,
                definition,
                property,
                items,
                target,
                names,
                targets,
                errors,
            );
        }
    }

    throwImportErrors(errors);
}

function compileProperties(
    type: CatalogEntry,
    entries: readonly CatalogEntry[],
): Map<string, PropertyDefinition> {
    const properties = new Map(systemProperties.map((property) => [property.name, property]));

    if (String(type.properties.is_versionable) === "1") {
        for (const property of versionableProperties) {
            properties.set(property.name, property);
        }
    }

    if (type.properties.is_relationship === "1" || type.properties.is_relationship === 1) {
        for (const property of relationshipProperties) {
            properties.set(property.name, property);
        }
    }

    for (const property of entries) {
        const propertyName = stringProperty(property, "name");
        const dataType = stringProperty(property, "data_type");

        if (!propertyName || !dataType) {
            throw new PackageImportError(
                "INVALID_PROPERTY",
                "Property requires name and data_type.",
                property.source,
            );
        }

        const dataSource = stringProperty(property, "data_source");
        const foreignProperty = stringProperty(property, "foreign_property");
        const defaultValue = property.properties.default_value;
        properties.set(propertyName, {
            id: property.id,
            name: propertyName,
            dataType,
            ...(dataSource ? { dataSource } : {}),
            ...(foreignProperty ? { foreignProperty } : {}),
            isRequired: String(property.properties.is_required ?? "0") === "1",
            isFederated: String(property.properties.is_federated ?? "0") === "1",
            ...(defaultValue !== undefined && defaultValue !== null ? { defaultValue } : {}),
            source: property.source,
        });
    }

    return properties;
}

function supplementBaselineProperties(
    name: string,
    entries: readonly CatalogEntry[],
    storage: HarnessStorage,
    properties: Map<string, PropertyDefinition>,
): void {
    if (baselineTypeNames.has(name)) {
        for (const entry of entries.filter((entry) => entry.type === name)) {
            for (const property of Object.keys(entry.properties)) {
                if (!properties.has(property)) {
                    properties.set(property, { name: property, dataType: "string" });
                }
            }
        }

        for (const property of storage.getItemType(name)?.properties ?? []) {
            if (!properties.has(property.name)) {
                properties.set(property.name, property);
            }
        }
    }
}

function validateTypeNames(types: readonly CatalogEntry[], errors: PackageImportError[]): void {
    const typeNames = new Map<string, CatalogEntry>();

    for (const type of types) {
        const name = stringProperty(type, "name");

        if (!name) {
            errors.push(
                new PackageImportError(
                    "INVALID_ITEM_TYPE",
                    "ItemType requires a name.",
                    type.source,
                ),
            );
            continue;
        }

        const existing = typeNames.get(name.toLowerCase());

        if (existing) {
            errors.push(
                new PackageImportError(
                    "DUPLICATE_ITEM_TYPE",
                    `Multiple ItemType IDs declare '${name}'. Other definition: ${existing.source.file}:${existing.source.line}.`,
                    type.source,
                    { relatedSources: [existing.source] },
                ),
            );
        } else {
            typeNames.set(name.toLowerCase(), type);
        }
    }
}

function missingTarget(
    catalog: ReadonlyMap<string, CatalogEntry>,
    definition: ItemTypeDefinition,
    property: PropertyDefinition,
    dataSource: string,
    items: readonly StoredItem[],
    errors: PackageImportError[],
): void {
    const source = property.source ?? definition.source ?? bootstrapSource("/");
    const metadata = catalog.get(JSON.stringify(["itemtype", dataSource.toLowerCase()]));
    const implementation = metadata?.properties.implementation_type;

    if (metadata && (implementation === "polymorphic" || implementation === "federated")) {
        const referenced = items.find((item) => {
            const value = getOwn(item.properties, property.name);

            return value !== undefined && value !== null && value !== "";
        });

        if (!referenced) {
            return;
        }

        errors.push(
            new PackageImportError(
                "UNSUPPORTED_IMPLEMENTATION",
                `Property '${definition.name}.${property.name}' references '${metadata.properties.name}' using '${implementation}' storage. Resolving its records requires an adapter.`,
                catalog.get(
                    JSON.stringify([referenced.type.toLowerCase(), referenced.id.toLowerCase()]),
                )?.source ?? source,
            ),
        );

        return;
    }

    errors.push(
        new PackageImportError(
            "MISSING_ITEM_TYPE",
            `Property '${definition.name}.${property.name}' references missing ItemType '${property.dataSource}'.`,
            source,
            { reference: { type: "ItemType", id: dataSource } },
        ),
    );
}

function validatePropertyReferences(
    catalog: ReadonlyMap<string, CatalogEntry>,
    definition: ItemTypeDefinition,
    property: PropertyDefinition,
    items: readonly StoredItem[],
    target: ItemTypeDefinition,
    names: ReadonlyMap<string, ItemTypeDefinition>,
    targets: ReadonlyMap<string, ReadonlySet<string>>,
    errors: PackageImportError[],
): void {
    const source = property.source ?? definition.source ?? bootstrapSource("/");

    for (const item of items) {
        const id = getOwn(item.properties, property.name);

        if (id === null || id === undefined || id === "") {
            continue;
        }

        // Property.data_source depends on data_type; lists, sequences and
        // foreign properties share the field's declared ItemType reference.
        let itemTarget = target;

        if (definition.name === "Property" && property.name === "data_source") {
            const dataType = item.properties.data_type;

            if (["list", "filter list", "mv_list"].includes(String(dataType))) {
                itemTarget = names.get("list") ?? target;
            } else if (dataType === "sequence") {
                itemTarget = names.get("sequence") ?? target;
            } else if (dataType === "foreign") {
                itemTarget = names.get("property") ?? target;
            }
        }

        if (typeof id !== "string" || !targets.get(itemTarget.name)?.has(id.toLowerCase())) {
            const itemSource =
                catalog.get(JSON.stringify([item.type.toLowerCase(), item.id.toLowerCase()]))
                    ?.source ?? source;
            errors.push(
                new PackageImportError(
                    "MISSING_REFERENCE",
                    `Property '${definition.name}.${property.name}' references missing '${itemTarget.name}' with ID '${id}'.`,
                    itemSource,
                    {
                        reference: {
                            type: itemTarget.name,
                            ...(typeof id === "string" ? { id } : {}),
                        },
                    },
                ),
            );
        }
    }
}

function convertValue(
    entry: CatalogEntry,
    name: string,
    value: StorageValue,
    property: PropertyDefinition | undefined,
): StorageValue {
    if (value === null || typeof value === "number") {
        return value;
    } else if (property?.dataType === "integer" || property?.dataType === "boolean") {
        const normalized = value.trim();

        if (!normalized && !property.isRequired) {
            return null;
        }

        const number = Number(normalized);

        if (
            !/^[+-]?\d+$/.test(normalized) ||
            !Number.isSafeInteger(number) ||
            (property.dataType === "boolean" && number !== 0 && number !== 1)
        ) {
            throw new PackageImportError(
                "INVALID_VALUE",
                `Invalid ${property.dataType} value for '${entry.type}.${name}': '${value}'.`,
                entry.source,
            );
        }

        return number;
    } else if (property?.dataType === "float") {
        const number = Number(value);

        if (!value.trim() || !Number.isFinite(number)) {
            throw new PackageImportError(
                "INVALID_VALUE",
                `Invalid float for '${entry.type}.${name}'.`,
                entry.source,
            );
        }

        return number;
    }

    return value;
}

function compileRelationshipProperties(
    type: CatalogEntry,
    entries: readonly CatalogEntry[],
    properties: Map<string, PropertyDefinition>,
): void {
    const relationship = entries.find(
        (entry) =>
            entry.type === "RelationshipType" &&
            typeof entry.properties.relationship_id === "string" &&
            entry.properties.relationship_id.toLowerCase() === type.id.toLowerCase(),
    );

    if (type.properties.is_relationship === "1" || type.properties.is_relationship === 1) {
        for (const name of ["source_id", "related_id"]) {
            const dataSource = relationship ? stringProperty(relationship, name) : undefined;
            const previous = properties.get(name);
            properties.set(name, {
                ...previous,
                name,
                dataType: "item",
                ...(dataSource ? { dataSource } : {}),
            });
        }
    }
}
