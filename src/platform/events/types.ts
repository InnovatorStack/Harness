import type { ExecutionContext } from "../../core/types.js";
import type { Item } from "../../items/item.js";
import type { CatalogEntry, ItemTypeDefinition } from "../../storage/types.js";

export enum ServerEventVersion {
    Item = "version_1",
    Collection = "version_2",
}

export interface EventBinding {
    readonly entry: CatalogEntry;
    readonly methodId: string;
    readonly required: boolean;
    readonly version: ServerEventVersion;
}

export type RunEvents = (
    definition: ItemTypeDefinition,
    name: string,
    item: Item,
    enabled: boolean,
    context: ExecutionContext,
) => Promise<void>;

export interface EventRunners {
    readonly item: RunEvents;
    readonly collection: RunEvents;
}
