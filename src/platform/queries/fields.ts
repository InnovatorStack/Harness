import { dataDepthMax } from "../../core/limits.js";
import type { AmlPropertyCondition } from "../../items/logical.js";
import type { QueryField, ReferencePath, ValueKind } from "../../queries/types.js";
import type {
    HarnessStorage,
    ItemTypeDefinition,
    PropertyDefinition,
    StorageValue,
    StoredItem,
} from "../../storage/types.js";
import { PlatformError } from "../errors.js";

export function resolveField(
    storage: HarnessStorage,
    definition: ItemTypeDefinition,
    names: readonly string[],
): QueryField {
    const name = names.at(-1);
    const qualifier = names.slice(0, -1).join(".").toLowerCase();
    const qualifiers = [definition.name, definition.tableName ?? definition.name].flatMap(
        (name) => [name, `innovator.${name}`, `dbo.${name}`],
    );

    if (!name || (qualifier && !qualifiers.some((value) => value.toLowerCase() === qualifier))) {
        throw new PlatformError(
            "UnsupportedWhere",
            `Where qualifier does not refer to '${definition.name}'.`,
        );
    }

    if (name.toLowerCase() === "id") {
        return { name: "id", column: "id", kind: "identifier", path: [] };
    }

    const property = definition.properties.find(
        (property) => property.name.toLowerCase() === name.toLowerCase(),
    );

    if (!property) {
        throw new PlatformError(
            "UnknownProperty",
            `Unknown selector '${definition.name}.${name}'.`,
        );
    }

    const path: ReferencePath[] = [];
    let current = { definition, property };
    const visited = new Set<string>();

    while (current.property.dataType === "foreign") {
        const key = `${current.definition.id}:${current.property.name}`;

        if (visited.has(key) || path.length >= dataDepthMax) {
            throw new PlatformError(
                "ForeignPropertyCycle",
                `Invalid foreign selector '${definition.name}.${name}'.`,
            );
        }

        visited.add(key);
        const next = foreignTarget(storage, current.definition, current.property);
        path.push({ property: next.source.name, target: next.definition.name });
        current = next;
    }

    if (current.property.isFederated) {
        throw new PlatformError(
            "UnsupportedFederatedPredicate",
            `Filtering '${definition.name}.${name}' requires federation query support.`,
        );
    }

    return {
        name: property.name,
        column: current.property.name,
        kind: valueKind(current.property),
        path,
    };
}

export function fieldValue(storage: HarnessStorage, record: StoredItem, field: QueryField) {
    let current: StoredItem | undefined = record;

    for (const reference of field.path) {
        const id: StorageValue | undefined = current?.properties[reference.property];
        current = typeof id === "string" ? storage.getItem(reference.target, id) : undefined;
    }

    return field.column === "id"
        ? (current?.id ?? null)
        : (current?.properties[field.column] ?? null);
}

function foreignTarget(
    storage: HarnessStorage,
    definition: ItemTypeDefinition,
    property: PropertyDefinition,
) {
    const source = definition.properties.find(
        (candidate) => candidate.id?.toLowerCase() === property.dataSource?.toLowerCase(),
    );
    const target = storage
        .listItemTypes()
        .find((candidate) => candidate.id.toLowerCase() === source?.dataSource?.toLowerCase());
    const targetProperty = target?.properties.find(
        (candidate) => candidate.id?.toLowerCase() === property.foreignProperty?.toLowerCase(),
    );

    if (!source || !target || !targetProperty) {
        throw new PlatformError(
            "InvalidForeignProperty",
            `Cannot resolve foreign selector '${definition.name}.${property.name}'.`,
        );
    }

    return { source, definition: target, property: targetProperty };
}

function valueKind(property: PropertyDefinition): ValueKind {
    if (property.dataType === "item" || property.name === "id") {
        return "identifier";
    }

    if (["integer", "boolean", "float"].includes(property.dataType)) {
        return "number";
    }

    if (property.dataType === "decimal" || property.dataType === "date") {
        return property.dataType;
    }

    return "text";
}

export function selectorType(
    storage: HarnessStorage,
    definition: ItemTypeDefinition,
    condition: AmlPropertyCondition,
): ItemTypeDefinition {
    const property = definition.properties.find((property) => property.name === condition.name);
    const selector = condition.item;
    const target = selector ? storage.getItemType(selector.type) : undefined;
    const operator = (condition.attributes.condition ?? "eq").toLowerCase();

    if (
        property?.dataType !== "item" ||
        !target ||
        !selector ||
        (selector.attributes.action ?? "get") !== "get" ||
        target.id.toLowerCase() !== property.dataSource?.toLowerCase() ||
        !["eq", "ne", "in", "not in"].includes(operator)
    ) {
        throw new PlatformError(
            "InvalidSelector",
            `Invalid nested selector for '${definition.name}.${condition.name}'.`,
        );
    }

    return target;
}
