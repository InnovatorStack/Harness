import { cloneData, freezeData } from "../core/data.js";
import { validateParameters } from "../mocks/parameters.js";
import type { MockValue } from "../mocks/types.js";
import { ItemAction } from "../platform/actions.js";
import { FailurePoint } from "./failure-types.js";
import type { FailureInjection } from "./failure-types.js";

export interface FailureRule {
    readonly target: {
        readonly kind: "action" | "method" | "sql";
        readonly name: string | true;
        readonly action?: ItemAction;
    };
    readonly when: Readonly<Record<string, MockValue>>;
    readonly at: FailurePoint;
    readonly occurrence: number;
    readonly error: Error;
}

export function prepareFailure(value: FailureInjection): FailureRule {
    const allowed = new Set([
        "type",
        "action",
        "method",
        "sql",
        "when",
        "at",
        "occurrence",
        "error",
    ]);

    if (
        value === null ||
        typeof value !== "object" ||
        Object.keys(value).some((key) => !allowed.has(key)) ||
        !(value.error instanceof Error)
    ) {
        throw new TypeError("A failure injection needs a target and an Error.");
    }

    const at = value.at ?? FailurePoint.BeforeCall;
    const occurrence = value.occurrence ?? 1;

    if (
        !Object.values(FailurePoint).includes(at) ||
        !Number.isSafeInteger(occurrence) ||
        occurrence < 1
    ) {
        throw new TypeError(
            "Failure injection requires a valid point and positive integer occurrence.",
        );
    }

    validateParameters(value.when ?? {}, "Failure injection 'when'");

    return {
        target: target(value),
        at,
        occurrence,
        error: value.error,
        when: freezeData(cloneData(value.when ?? {})),
    };
}

function target(value: FailureInjection): FailureRule["target"] {
    if (
        nonempty(value.type) &&
        value.action !== undefined &&
        Object.values(ItemAction).includes(value.action) &&
        value.method === undefined &&
        value.sql === undefined
    ) {
        return { kind: "action", name: value.type, action: value.action };
    }

    if (
        nonempty(value.method) &&
        value.type === undefined &&
        value.action === undefined &&
        value.sql === undefined
    ) {
        return { kind: "method", name: value.method };
    }

    if (
        (value.sql === true || nonempty(value.sql)) &&
        value.type === undefined &&
        value.action === undefined &&
        value.method === undefined
    ) {
        return { kind: "sql", name: value.sql };
    }

    throw new TypeError("Select one failure target: an ItemType/action, a Method, or SQL.");
}

function nonempty(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}
