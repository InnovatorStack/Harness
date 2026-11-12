export enum MethodEventDataKind {
    BeforeUpdate = "onBeforeUpdate",
    AfterAdd = "onAfterAdd",
    AfterUpdate = "onAfterUpdate",
    AfterVersion = "onAfterVersion",
}

export interface BeforeUpdateEventData {
    readonly kind: MethodEventDataKind.BeforeUpdate;
    readonly id: string;
    readonly idList: readonly string[];
}

export interface AfterAddEventData {
    readonly kind: MethodEventDataKind.AfterAdd;
    readonly typeId: string;
    readonly id: string;
    readonly idList: readonly string[];
}

export interface AfterUpdateEventData {
    readonly kind: MethodEventDataKind.AfterUpdate;
    readonly typeId: string;
    readonly id: string | null;
    readonly oldIdsNewIdsMap: Readonly<Record<string, string>>;
}

export interface AfterVersionEventData {
    readonly kind: MethodEventDataKind.AfterVersion;
    readonly typeId: string;
    readonly newItemId: string;
    readonly oldIdsNewIdsMap: Readonly<Record<string, string>>;
}

export type MethodEventData =
    | BeforeUpdateEventData
    | AfterAddEventData
    | AfterUpdateEventData
    | AfterVersionEventData;
