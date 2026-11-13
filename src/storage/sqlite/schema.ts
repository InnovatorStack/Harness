import { isBaselineSource } from "../../baseline/source.js";
import { isFrozenData } from "../../core/data.js";
import type { ItemTypeDefinition, PropertyDefinition, StorageValue } from "../types.js";
import { StorageError } from "./errors.js";

type ColumnKind = "text" | "integer" | "boolean" | "float" | "decimal";

export interface StorageColumn {
    readonly name: string;
    readonly kind: ColumnKind;
    readonly declaration: "TEXT" | "INTEGER" | "REAL";
}

const textDataTypes = new Set([
    "string",
    "text",
    "formatted text",
    "ml_string",
    "item",
    "date",
    "image",
    "color",
    "list",
    "filter list",
    "sequence",
    "mv_list",
    "md5",
]);

interface ColumnLayout {
    readonly columns: readonly StorageColumn[];
    readonly byName: ReadonlyMap<string, StorageColumn>;
}

const columnLayouts = new WeakMap<ItemTypeDefinition, ColumnLayout>();

export function quoteIdentifier(name: string): string {
    // oxlint-disable-next-line no-control-regex -- SQL identifiers must reject control characters.
    if (!name || /[\u0000-\u001F\u007F]/u.test(name)) {
        throw new StorageError("INVALID_SCHEMA", `Invalid SQL identifier ${JSON.stringify(name)}.`);
    }

    return `"${name.replaceAll('"', '""')}"`;
}

export function tableName(definition: ItemTypeDefinition): string {
    return definition.tableName ?? definition.name;
}

function propertyColumn(property: PropertyDefinition): StorageColumn {
    const dataType = property.dataType.toLowerCase();

    if (textDataTypes.has(dataType)) {
        return { name: property.name, kind: "text", declaration: "TEXT" };
    }

    switch (dataType) {
        case "integer": {
            return { name: property.name, kind: "integer", declaration: "INTEGER" };
        }
        case "boolean": {
            return { name: property.name, kind: "boolean", declaration: "INTEGER" };
        }
        case "float": {
            return { name: property.name, kind: "float", declaration: "REAL" };
        }
        case "decimal": {
            return { name: property.name, kind: "decimal", declaration: "TEXT" };
        }
        default: {
            throw new StorageError(
                "INVALID_SCHEMA",
                `Property ${property.name} uses unsupported storage data type ${JSON.stringify(property.dataType)}.`,
            );
        }
    }
}

export function columnsFor(definition: ItemTypeDefinition): readonly StorageColumn[] {
    return columnLayout(definition).columns;
}

export function columnFor(definition: ItemTypeDefinition, name: string): StorageColumn | undefined {
    return columnLayout(definition).byName.get(name);
}

function columnLayout(definition: ItemTypeDefinition): ColumnLayout {
    const immutable = isFrozenData(definition);
    const cached = immutable ? columnLayouts.get(definition) : undefined;

    if (cached) {
        return cached;
    }

    const columns = compileColumns(definition);

    if (immutable) {
        for (const column of columns) {
            Object.freeze(column);
        }

        Object.freeze(columns);
    }

    const layout = { columns, byName: new Map(columns.map((column) => [column.name, column])) };

    if (immutable) {
        columnLayouts.set(definition, layout);
    }

    return layout;
}

function compileColumns(definition: ItemTypeDefinition): StorageColumn[] {
    const columns: StorageColumn[] = [{ name: "id", kind: "text", declaration: "TEXT" }];

    if (definition.isRelationship) {
        columns.push(
            { name: "source_id", kind: "text", declaration: "TEXT" },
            { name: "related_id", kind: "text", declaration: "TEXT" },
        );
    }

    const declaredNames = new Set<string>();

    for (const property of definition.properties) {
        quoteIdentifier(property.name);
        const key = property.name.toLowerCase();

        if (declaredNames.has(key)) {
            throw new StorageError(
                "INVALID_SCHEMA",
                `Duplicate property ${property.name} on ${definition.name}.`,
            );
        }

        declaredNames.add(key);

        if (property.dataType.toLowerCase() === "foreign" || property.isFederated) {
            continue;
        }

        if (key.startsWith("_harness_") || ["rowid", "_rowid_", "oid"].includes(key)) {
            throw new StorageError("INVALID_SCHEMA", `Property name ${property.name} is reserved.`);
        }

        const column = propertyColumn(property);
        const systemColumn = columns.find((existing) => existing.name.toLowerCase() === key);

        if (systemColumn) {
            if (column.kind !== "text") {
                throw new StorageError(
                    "INVALID_SCHEMA",
                    `System property ${property.name} must use a text storage type.`,
                );
            }
        } else {
            columns.push(column);
        }
    }

    return columns;
}

export function validateDefinition(definition: ItemTypeDefinition): void {
    if (!definition.id || !definition.name) {
        throw new StorageError("INVALID_SCHEMA", "ItemType id and name must be non-empty strings.");
    }

    const name = tableName(definition);
    quoteIdentifier(name);

    if (/^(?:_harness_|sqlite_)/iu.test(name)) {
        throw new StorageError("INVALID_SCHEMA", `Table name ${name} is reserved.`);
    }

    columnsFor(definition);
}

export function assertCompatible(previous: ItemTypeDefinition, next: ItemTypeDefinition): void {
    const replacingBaseline = isBaselineSource(previous.source) && !isBaselineSource(next.source);

    if (
        (previous.id !== next.id && !replacingBaseline) ||
        previous.name !== next.name ||
        tableName(previous).toLowerCase() !== tableName(next).toLowerCase() ||
        (!replacingBaseline && Boolean(previous.isRelationship) !== Boolean(next.isRelationship))
    ) {
        throw new StorageError(
            "INCOMPATIBLE_SCHEMA",
            `Cannot change the identity, table, or relationship kind of ${previous.name}.`,
        );
    }

    if (replacingBaseline) {
        const previousColumns = columnsFor(previous);
        const nextColumns = columnsFor(next);

        for (const column of previousColumns) {
            const replacement = nextColumns.find((candidate) => candidate.name === column.name);

            if (!replacement || replacement.declaration !== column.declaration) {
                throw new StorageError(
                    "INCOMPATIBLE_SCHEMA",
                    `Native metadata cannot change the storage column ${previous.name}.${column.name}.`,
                );
            }
        }

        return;
    }

    for (const property of previous.properties) {
        const replacement = next.properties.find((candidate) => candidate.name === property.name);

        if (
            !replacement ||
            property.dataType.toLowerCase() !== replacement.dataType.toLowerCase() ||
            (property.dataSource !== replacement.dataSource &&
                !isBaselineSource(property.source)) ||
            (property.foreignProperty !== replacement.foreignProperty &&
                !isBaselineSource(property.source))
        ) {
            throw new StorageError(
                "INCOMPATIBLE_SCHEMA",
                `Cannot remove or change property ${previous.name}.${property.name}.`,
            );
        }
    }
}

export function normalizeValue(column: StorageColumn, value: StorageValue): StorageValue {
    if (value === null) {
        return null;
    }

    switch (column.kind) {
        case "text": {
            if (typeof value === "string") {
                return value;
            }

            break;
        }
        case "integer": {
            if (typeof value === "number" && Number.isSafeInteger(value)) {
                return value;
            }

            break;
        }
        case "boolean": {
            if (value === 0 || value === 1) {
                return value;
            }

            break;
        }
        case "float": {
            if (typeof value === "number" && Number.isFinite(value)) {
                return value;
            }

            break;
        }
        case "decimal": {
            if (typeof value === "string" && /^[+-]?\d+(?:\.\d+)?$/u.test(value)) {
                return value;
            }

            if (typeof value === "number" && Number.isFinite(value)) {
                return String(value);
            }

            break;
        }
        default: {
            const unexpected: never = column.kind;

            throw new Error(`Unknown storage column kind: ${String(unexpected)}`);
        }
    }

    throw new StorageError(
        "INVALID_ITEM",
        `Property ${column.name} requires a ${column.kind} value; received ${JSON.stringify(value)}.`,
    );
}
