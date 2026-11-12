import { MethodEventDataKind } from "../../methods/event-data.js";
import type { AfterEventItem } from "./types.js";

export function afterAddFrames(typeId: string, id: string): readonly AfterEventItem[] {
    return [{ id, data: { kind: MethodEventDataKind.AfterAdd, typeId, id, idList: [id] } }];
}

export function afterUpdateFrames(
    typeId: string,
    oldIdsNewIdsMap: Readonly<Record<string, string>>,
): readonly AfterEventItem[] {
    return Object.values(oldIdsNewIdsMap).map((id) => ({
        id,
        data: { kind: MethodEventDataKind.AfterUpdate, typeId, id, oldIdsNewIdsMap },
    }));
}

export function afterVersionFrames(
    typeId: string,
    oldIdsNewIdsMap: Readonly<Record<string, string>>,
): readonly AfterEventItem[] {
    return Object.entries(oldIdsNewIdsMap).map(([id, newItemId]) => ({
        id,
        data: { kind: MethodEventDataKind.AfterVersion, typeId, newItemId, oldIdsNewIdsMap },
    }));
}
