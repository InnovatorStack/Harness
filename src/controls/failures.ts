import { freezeData } from "../core/data.js";
import type { RuntimeExecution } from "../core/types.js";
import { matchesParameters } from "../mocks/registry.js";
import { PlatformError } from "../platform/errors.js";
import { FailurePoint, InjectedFailureError } from "./failure-types.js";
import type {
    ExecutionInjection,
    FailureInjection,
    InjectedFailureHandle,
} from "./failure-types.js";
import { prepareFailure } from "./failure-validation.js";
import type { FailureRule } from "./failure-validation.js";
import type { InjectionDetails, InjectionTarget } from "./targets.js";

interface RegisteredRule {
    readonly id: string;
    readonly rule: FailureRule;
    active: boolean;
    triggered: boolean;
    matches: number;
}

interface PendingInjection {
    readonly requestId: string;
    readonly target: InjectionDetails;
    readonly rules: readonly RegisteredRule[];
}

const activeRulesMax = 128;
const registrationsMax = 100_000;

/** Rules count matching call entries. After-call faults run only if that invocation succeeds. */
export class FailureRegistry {
    private readonly rules = new Set<RegisteredRule>();
    private readonly pending = new Map<string, PendingInjection>();
    private serial = 0;

    constructor(
        private readonly record: (
            execution: RuntimeExecution,
            evidence: ExecutionInjection,
            target: InjectionDetails,
        ) => void,
    ) {}

    get hasRules(): boolean {
        return this.rules.size > 0;
    }

    add(injection: FailureInjection): InjectedFailureHandle {
        const rule = prepareFailure(injection);

        if (this.rules.size >= activeRulesMax || this.serial >= registrationsMax) {
            throw new RangeError("The world failure-injection limit was reached. Reset the world.");
        }

        const registered: RegisteredRule = {
            id: String(++this.serial),
            rule,
            active: true,
            triggered: false,
            matches: 0,
        };
        this.rules.add(registered);

        return Object.freeze({
            get triggered() {
                return registered.triggered;
            },

            [Symbol.dispose]: () => {
                registered.active = false;
                this.rules.delete(registered);
            },
        });
    }

    enter(execution: RuntimeExecution, target: InjectionTarget): void {
        const selected: RegisteredRule[] = [];

        for (const registered of this.rules) {
            if (matches(registered.rule, target)) {
                registered.matches += 1;

                if (registered.matches === registered.rule.occurrence) {
                    selected.push(registered);
                }
            }
        }

        const before = selected.filter((entry) => entry.rule.at === FailurePoint.BeforeCall);
        this.trigger(execution, target, before);
        const after = selected.filter((entry) => entry.rule.at === FailurePoint.AfterCall);

        if (after.length > 0) {
            const { values: _values, aliases: _aliases, action: _action, ...details } = target;
            this.pending.set(execution.executionId, {
                requestId: execution.requestId,
                target: details,
                rules: after,
            });
        }
    }

    complete(execution: RuntimeExecution): void {
        const pending = this.pending.get(execution.executionId);
        this.pending.delete(execution.executionId);

        if (pending) {
            this.trigger(
                execution,
                pending.target,
                pending.rules.filter((rule) => rule.active),
            );
        }
    }

    failed(execution: RuntimeExecution): void {
        this.pending.delete(execution.executionId);
    }

    settled(requestId: string): void {
        for (const [id, pending] of this.pending) {
            if (pending.requestId === requestId) {
                this.pending.delete(id);
            }
        }
    }

    reset(): void {
        for (const entry of this.rules) {
            entry.active = false;
        }

        this.rules.clear();
        this.pending.clear();
        this.serial = 0;
    }

    private trigger(
        execution: RuntimeExecution,
        target: InjectionDetails,
        selected: readonly RegisteredRule[],
    ): void {
        if (selected.length > 1) {
            throw new PlatformError(
                "AmbiguousInjection",
                `Ambiguous failure injections at '${target.name}'. Narrow their targets.`,
            );
        }

        const entry = selected[0];

        if (!entry) {
            return;
        }

        entry.triggered = true;
        entry.active = false;
        this.rules.delete(entry);
        const evidence: ExecutionInjection = freezeData({
            id: entry.id,
            executionId: execution.executionId,
            name: target.name,
            at: entry.rule.at,
            occurrence: entry.rule.occurrence,
            ...(target.source ? { source: { ...target.source } } : {}),
            error: {
                name: entry.rule.error.name.slice(0, 128),
                message: entry.rule.error.message.slice(0, 2048),
            },
        });
        this.record(execution, evidence, target);

        throw new InjectedFailureError(evidence, entry.rule.error);
    }
}

function matches(rule: FailureRule, target: InjectionTarget): boolean {
    return (
        rule.target.kind === target.kind &&
        (rule.target.action === undefined || rule.target.action === target.action) &&
        target.aliases.some((name) => sameName(rule.target.name, name)) &&
        matchesParameters(rule.when, target.values)
    );
}

function sameName(left: string | true, right: string | true): boolean {
    return typeof left === "string" && typeof right === "string"
        ? left.toLowerCase() === right.toLowerCase()
        : left === right;
}
