import type { StorageValue } from "../../storage/types.js";
import { PlatformError } from "../errors.js";

export enum ReferenceBehavior {
    Fixed = "fixed",
    Float = "float",
    HardFixed = "hard_fixed",
    HardFloat = "hard_float",
}

export function referenceBehavior(value: StorageValue | undefined): ReferenceBehavior | undefined {
    if (value === undefined || value === null || value === "") {
        return undefined;
    }

    const behavior = Object.values(ReferenceBehavior).find(
        (behavior: string) => behavior === value,
    );

    if (behavior === undefined) {
        throw new PlatformError(
            "InvalidReferenceBehavior",
            `Unknown reference behavior '${value}'.`,
        );
    }

    return behavior;
}

export function hardBehavior(behavior: ReferenceBehavior): boolean {
    return behavior === ReferenceBehavior.HardFixed || behavior === ReferenceBehavior.HardFloat;
}

export function floats(behavior: ReferenceBehavior): boolean {
    return behavior === ReferenceBehavior.Float || behavior === ReferenceBehavior.HardFloat;
}
