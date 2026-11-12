import type { HarnessStorage, ItemTypeDefinition } from "../storage/types.js";
import { PlatformError } from "./errors.js";

export function relationshipType(
    storage: HarnessStorage,
    parent: ItemTypeDefinition,
    type: string,
): ItemTypeDefinition {
    const definition = storage.getItemType(type);
    const source = definition?.properties.find((property) => property.name === "source_id");

    if (
        !definition?.isRelationship ||
        source?.dataSource?.toLowerCase() !== parent.id.toLowerCase()
    ) {
        throw new PlatformError(
            "RelationshipSource",
            `'${type}' is not an imported relationship of '${parent.name}'.`,
        );
    }

    return definition;
}
