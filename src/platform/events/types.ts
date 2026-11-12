import type { ExecutionContext } from "../../core/types.js";
import type { Item } from "../../items/item.js";
import type { MethodEventData } from "../../methods/event-data.js";
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
    data?: MethodEventData,
) => Promise<void>;

export interface AfterEventItem {
    readonly id: string;
    readonly data: MethodEventData;
}

export type RunAfterEvents = (
    definition: ItemTypeDefinition,
    name: string,
    items: readonly AfterEventItem[],
    enabled: boolean,
    context: ExecutionContext,
) => Promise<void>;

export interface EventRunners {
    readonly item: RunEvents;
    readonly collection: RunEvents;
    readonly after: RunAfterEvents;
}
