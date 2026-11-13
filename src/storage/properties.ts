import { isFrozenData } from "../core/data.js";
import type { ItemTypeDefinition, PropertyDefinition } from "./types.js";

const propertiesByType = new WeakMap<ItemTypeDefinition, ReadonlyMap<string, PropertyDefinition>>();

/** Only validated immutable definitions can retain an index across calls. */
export function propertyFor(
    definition: ItemTypeDefinition,
    name: string,
): PropertyDefinition | undefined {
    if (!isFrozenData(definition)) {
        return definition.properties.find((property) => property.name === name);
    }

    let indexed = propertiesByType.get(definition);

    if (!indexed) {
        const properties = new Map<string, PropertyDefinition>();

        for (const property of definition.properties) {
            if (!properties.has(property.name)) {
                properties.set(property.name, property);
            }
        }

        indexed = properties;
        propertiesByType.set(definition, indexed);
    }

    return indexed.get(name);
}
