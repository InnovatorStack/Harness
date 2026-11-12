import { getOwn, setOwn } from "../core/data.js";
import type {
    HarnessStorage,
    ItemTypeDefinition,
    PropertyDefinition,
    StorageValue,
    StoredItem,
} from "../storage/types.js";
import { PlatformError } from "./errors.js";
import { projectedProperties } from "./query.js";

export interface ItemReference {
    readonly type: string;
    readonly id: string;
    readonly world: symbol;
    readonly generation: number;
}

export type SeedValue = StorageValue | ItemReference;

interface NormalizationOptions {
    readonly creating: boolean;
    readonly current?: StoredItem;
    readonly id?: string;
    readonly pendingReferences?: ReadonlySet<string>;
}

export function normalizeProperties(
    storage: HarnessStorage,
    definition: ItemTypeDefinition,
    values: Readonly<Record<string, StorageValue>>,
    options: NormalizationOptions,
): Record<string, StorageValue> {
    const normalized: Record<string, StorageValue> = {};
    const inputs = { ...values };

    if (options.creating) {
        for (const property of definition.properties) {
            if (inputs[property.name] === undefined && property.defaultValue !== undefined) {
                setOwn(inputs, property.name, property.defaultValue);
            }
        }
    }

    for (const [name, value] of Object.entries(inputs)) {
        const property = definition.properties.find((property) => property.name === name);

        if (!property) {
            throw new PlatformError(
                "UnknownProperty",
                `Unknown property '${definition.name}.${name}'.`,
            );
        }

        if (isUnchangedComputedProperty(storage, definition, property, value, options)) {
            continue;
        }

        const converted = normalizeValue(definition, property, value);
        validateItemReference(storage, definition, property, converted, options);

        if (property.isRequired && (converted === null || converted === "")) {
            throw new PlatformError(
                "RequiredProperty",
                `Required property '${definition.name}.${name}' is missing.`,
            );
        }

        setOwn(normalized, name, converted);
    }

    validateRequiredProperties(definition, normalized, options.creating);

    return normalized;
}

function normalizeValue(
    definition: ItemTypeDefinition,
    property: PropertyDefinition,
    value: StorageValue,
): StorageValue {
    let converted = value;

    if (value === "" && ["integer", "boolean", "float", "decimal"].includes(property.dataType)) {
        converted = null;
    }

    if (
        converted !== null &&
        typeof converted === "string" &&
        ["integer", "boolean", "float"].includes(property.dataType)
    ) {
        const pattern =
            property.dataType === "float"
                ? /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/
                : /^[+-]?\d+$/;

        if (!pattern.test(converted.trim()) || !Number.isFinite(Number(converted))) {
            throw new PlatformError(
                "InvalidValue",
                `Invalid ${property.dataType} value for '${definition.name}.${property.name}'.`,
            );
        }

        converted = Number(converted);
    }

    return converted;
}

function validateItemReference(
    storage: HarnessStorage,
    definition: ItemTypeDefinition,
    property: PropertyDefinition,
    converted: StorageValue,
    options: NormalizationOptions,
): void {
    if (
        property.dataType === "item" &&
        property.dataSource &&
        converted !== null &&
        converted !== ""
    ) {
        const target = storage
            .listItemTypes()
            .find((type) => type.id.toLowerCase() === property.dataSource?.toLowerCase());

        if (!target) {
            throw new PlatformError(
                "MissingItemType",
                `Missing target ItemType '${property.dataSource}' for '${definition.name}.${property.name}'.`,
            );
        }

        const self = options.creating && target.id === definition.id && converted === options.id;
        const familyIdentity = property.name === "config_id" && target.id === definition.id;
        const pending =
            typeof converted === "string" &&
            options.pendingReferences?.has(
                JSON.stringify([target.name.toLowerCase(), converted.toLowerCase()]),
            );

        if (
            !self &&
            !familyIdentity &&
            !pending &&
            (typeof converted !== "string" || !storage.getItem(target.name, converted))
        ) {
            throw new PlatformError(
                "MissingReference",
                `Missing '${target.name}' record '${converted}' referenced by '${definition.name}.${property.name}'.`,
            );
        }
    }
}

function isUnchangedComputedProperty(
    storage: HarnessStorage,
    definition: ItemTypeDefinition,
    property: PropertyDefinition,
    value: StorageValue,
    options: NormalizationOptions,
): boolean {
    if (property.dataType === "foreign" || property.isFederated) {
        if (options.current) {
            const computed = getOwn(
                projectedProperties(storage, definition, options.current, [property.name]),
                property.name,
            );

            if (
                computed === value ||
                (computed !== null &&
                    computed !== undefined &&
                    value !== null &&
                    String(computed) === String(value))
            ) {
                return true;
            }
        }

        throw new PlatformError(
            "ReadOnlyProperty",
            `Property '${definition.name}.${property.name}' is computed and cannot be written.`,
        );
    }

    return false;
}

function validateRequiredProperties(
    definition: ItemTypeDefinition,
    normalized: Readonly<Record<string, StorageValue>>,
    creating: boolean,
): void {
    if (!creating) {
        return;
    }

    for (const property of definition.properties) {
        if (property.dataType === "foreign" || property.isFederated || property.name === "id") {
            continue;
        }

        if (
            property.isRequired &&
            (normalized[property.name] === undefined ||
                normalized[property.name] === null ||
                normalized[property.name] === "")
        ) {
            throw new PlatformError(
                "RequiredProperty",
                `Required property '${definition.name}.${property.name}' is missing.`,
            );
        }
    }
}
