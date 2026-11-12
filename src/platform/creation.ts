import type { ItemTypeDefinition, StorageValue } from "../storage/types.js";
import { PlatformError } from "./errors.js";

/** Required native creation fields are supplied by actions, never by fixture import. */
export function creationDefaults(
    definition: ItemTypeDefinition,
    values: Readonly<Record<string, StorageValue>>,
    userId: (() => string) | undefined,
    now: () => Date = () => new Date(),
): Readonly<Record<string, StorageValue>> {
    const defaults: Record<string, StorageValue> = {};

    for (const property of definition.properties) {
        if (
            !property.isRequired ||
            values[property.name] !== undefined ||
            property.defaultValue !== undefined
        ) {
            continue;
        }

        if (property.name === "created_on" && property.dataType === "date") {
            defaults.created_on = now().toISOString();
        } else if (property.name === "created_by_id" && property.dataType === "item") {
            if (!userId) {
                throw new PlatformError(
                    "SessionRequired",
                    `Adding '${definition.name}' requires a User session for created_by_id.`,
                );
            }

            defaults.created_by_id = userId();
        }
    }

    return defaults;
}
