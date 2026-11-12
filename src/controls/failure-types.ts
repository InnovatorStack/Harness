import type { SourceLocation } from "../diagnostics/source-location.js";
import type { MockValue } from "../mocks/types.js";
import type { ItemAction } from "../platform/actions.js";

export enum FailurePoint {
    BeforeCall = "BEFORE_CALL",
    AfterCall = "AFTER_CALL",
}

type FailureTarget =
    | {
          readonly type: string;
          readonly action: ItemAction;
          readonly method?: never;
          readonly sql?: never;
      }
    | {
          readonly method: string;
          readonly type?: never;
          readonly action?: never;
          readonly sql?: never;
      }
    | {
          readonly sql: string | true;
          readonly type?: never;
          readonly action?: never;
          readonly method?: never;
      };

export type FailureInjection = FailureTarget & {
    readonly when?: Readonly<Record<string, MockValue>>;
    readonly at?: FailurePoint;
    readonly occurrence?: number;
    readonly error: Error;
};

export interface InjectedFailureHandle extends Disposable {
    readonly triggered: boolean;
}

export interface ExecutionInjection {
    readonly id: string;
    readonly executionId: string;
    readonly name: string;
    readonly at: FailurePoint;
    readonly occurrence: number;
    readonly source?: SourceLocation;
    readonly error: { readonly name: string; readonly message: string };
}

export class InjectedFailureError extends Error {
    override readonly name = "InjectedFailureError";
    readonly code = "InjectedFailure";

    constructor(
        readonly injection: ExecutionInjection,
        cause: Error,
    ) {
        super(injection.error.message, { cause });
    }
}
