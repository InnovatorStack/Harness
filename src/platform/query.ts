import { getOwn, setOwn } from "../core/data.js";
import { dataDepthMax } from "../core/limits.js";
import type { ItemNode } from "../items/item.js";
import { compareValues } from "../queries/values.js";
import type {
    HarnessStorage,
    ItemTypeDefinition,
    PropertyDefinition,
    StorageValue,
    StoredItem,
} from "../storage/types.js";
import { PlatformError } from "./errors.js";
import { fieldValue, resolveField } from "./queries/fields.js";

export interface EqualityPredicate {
    readonly name: string;
    readonly value: StorageValue;
}

export function matches(
    storage: HarnessStorage,
    definition: ItemTypeDefinition,
    record: StoredItem,
    predicate: EqualityPredicate,
): boolean {
    const field = resolveField(storage, definition, [predicate.name]);
    const actual = fieldValue(storage, record, field);

    if (predicate.value === null) {
        return actual === null;
    }

    return compareValues(field.kind, actual, predicate.value) === 0;
}

export function projectedProperties(
    storage: HarnessStorage,
    definition: ItemTypeDefinition,
    record: StoredItem,
    selected?: readonly string[],
    visiting = new Set<string>(),
): Record<string, StorageValue> {
    const properties: Record<string, StorageValue> = {};
    const names = selected ?? definition.properties.map((property) => property.name);

    for (const name of names) {
        if (name === "id") {
            continue;
        }

        const property = definition.properties.find((property) => property.name === name);

        if (!property) {
            throw new PlatformError(
                "UnknownProperty",
                `Unknown property '${definition.name}.${name}'.`,
            );
        }

        if (property.isFederated) {
            setOwn(properties, name, null);
            continue;
        }

        if (property.dataType !== "foreign") {
            const value = getOwn(record.properties, name);

            if (value !== undefined) {
                setOwn(properties, name, value);
            }

            continue;
        }

        setOwn(properties, name, foreignValue(storage, definition, record, property, visiting));
    }

    return properties;
}

function foreignValue(
    storage: HarnessStorage,
    definition: ItemTypeDefinition,
    record: StoredItem,
    property: PropertyDefinition,
    ancestors: ReadonlySet<string>,
): StorageValue {
    const visiting = new Set(ancestors);
    let current = { definition, record, property };

    while (true) {
        const { definition, record, property } = current;

        if (visiting.size >= dataDepthMax) {
            throw new PlatformError(
                "InvalidForeignProperty",
                "The foreign-property chain is too deep.",
            );
        }

        const key = `${record.type}:${record.id}:${property.name}`;

        if (visiting.has(key)) {
            throw new PlatformError(
                "ForeignPropertyCycle",
                `Foreign property cycle at '${definition.name}.${property.name}'.`,
            );
        }

        visiting.add(key);
        const { source, targetDefinition, targetProperty } = foreignTarget(
            storage,
            definition,
            property,
        );

        const targetId = getOwn(record.properties, source.name);
        const target =
            typeof targetId === "string" && targetId !== ""
                ? storage.getItem(targetDefinition.name, targetId)
                : undefined;

        if (!target) {
            return null;
        }

        if (targetProperty.name === "id") {
            return target.id;
        }

        if (targetProperty.isFederated) {
            return null;
        }

        if (targetProperty.dataType !== "foreign") {
            return getOwn(target.properties, targetProperty.name) ?? null;
        }

        current = { definition: targetDefinition, record: target, property: targetProperty };
    }
}

function foreignTarget(
    storage: HarnessStorage,
    definition: ItemTypeDefinition,
    property: PropertyDefinition,
) {
    const source = definition.properties.find((candidate) => candidate.id === property.dataSource);
    const targetDefinition = storage.listItemTypes().find((type) => type.id === source?.dataSource);
    const targetProperty = targetDefinition?.properties.find(
        (candidate) => candidate.id === property.foreignProperty,
    );

    if (!source || !targetDefinition || !targetProperty) {
        throw new PlatformError(
            "InvalidForeignProperty",
            `Cannot resolve foreign property '${definition.name}.${property.name}'.`,
        );
    }

    return { source, targetDefinition, targetProperty };
}

export function selectedProperties(request: ItemNode): readonly string[] | undefined {
    const select = request.attributes.select;

    if (!select || select === "*") {
        return undefined;
    }

    const names = select.split(",").map((name) => name.trim());

    if (names.some((name) => !/^[A-Za-z_][\w]*$/.test(name))) {
        throw new PlatformError("UnsupportedSelect", `Unsupported select '${select}'.`);
    }

    return names;
}
