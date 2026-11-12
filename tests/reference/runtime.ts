import { cloneData, freezeData } from "../../src/core/data.js";
import {
    createHarness,
    ExecutionKind,
    ExecutionOutcome,
    fixedClock,
    seededIds,
} from "../../src/index.js";
import type { ExecutionCall, ExecutionReport, Harness } from "../../src/index.js";
import { Item } from "../../src/items/item.js";
import { parseItems } from "../../src/items/xml.js";
import type { Corpus } from "./corpus.js";
import { corpusDirectory } from "./corpus.js";
import { fixtureBindings, sessionUser, watchedTypes } from "./model.js";
import { methodContext, projectPayload, projectRecord } from "./projection.js";
import type { CaseRun, EventObservation, ReferenceCase, StepObservation } from "./types.js";

export async function openReferenceWorld(): Promise<Harness> {
    return await createHarness({
        cwd: corpusDirectory,
        config: {
            clock: fixedClock("2026-01-01T00:00:00Z"),
            ids: seededIds("reference-corpus"),
            session: { user: sessionUser },
        },
    });
}

/** Each case starts from the original package/fixture checkpoint, without mocks. */
export async function runCase(
    h: Harness,
    corpus: Corpus,
    definition: ReferenceCase,
): Promise<CaseRun> {
    h.reset();
    const initial = state(h);
    const bindings = new Map<string, string>();

    for (const [name, selector] of Object.entries(fixtureBindings)) {
        bindings.set(name, h.state.getOne(selector.type, { item_number: selector.item_number }).id);
    }

    const steps: StepObservation[] = [];

    for (const step of definition.steps) {
        const aml = resolveRequest(step.aml, bindings);
        const request = { items: parseItems(aml).flatMap((item) => item.payload.items) };
        const previous = h.executions.at(-1);
        let result: Item;

        try {
            result = await h.applyAML(aml);
        } catch (error) {
            const report = h.executions.at(-1);

            if (!report?.error) {
                throw new Error(`Case '${definition.id}' failed without a completed report.`, {
                    cause: error,
                });
            }

            result = Item.error(report.error.message, report.error.code ?? report.error.name);
        }

        const report = completeReport(h.executions.at(-1));

        if (report === previous) {
            throw new Error("Every reference step must produce its own completed request report.");
        }

        steps.push({
            name: step.name,
            request: projectPayload(request),
            response: projectPayload(result.payload),
            outcome: report.outcome,
            events: events(report.calls),
            state: state(h),
        });

        if (!result.isError() && result.getItemCount() === 1 && result.getID()) {
            bindings.set(step.name, result.getID());
        }
    }

    return freezeData({
        caseId: definition.id,
        inputHash: corpus.hash(definition),
        observation: { initial, steps },
    });
}

export function resolveRequest(template: string, bindings: ReadonlyMap<string, string>): string {
    return template.replaceAll(/\{\{([a-z][a-z0-9-]*)\}\}/gu, (_token, name: string) => {
        const id = bindings.get(name);

        if (!id || !/^[A-F\d]{32}$/iu.test(id)) {
            throw new Error(`Request binding '${name}' must resolve to one native item ID.`);
        }

        return id;
    });
}

function state(h: Harness) {
    return watchedTypes.flatMap((entry) => h.state.get(entry.type).map(projectRecord));
}

function completeReport(report: ExecutionReport | undefined): ExecutionReport {
    if (
        !report ||
        report.truncated ||
        report.mocks.length > 0 ||
        report.failures.length > 0 ||
        report.outcome === ExecutionOutcome.Unknown ||
        report.error?.capability !== undefined
    ) {
        throw new Error(
            "Reference cases require complete, unmocked execution and a known transaction outcome.",
        );
    }

    return report;
}

function events(roots: readonly ExecutionCall[]): readonly EventObservation[] {
    const observed: EventObservation[] = [];
    const pending = [...roots].reverse();

    while (pending.length > 0) {
        const call = pending.pop();

        if (!call) {
            throw new Error("A pending call must exist while traversing the call tree.");
        }

        if (call.kind === ExecutionKind.Method && call.via?.kind === "event") {
            observed.push({
                method: call.name,
                event: call.via.name,
                context: methodContext(call.input),
            });
        }

        pending.push(...[...call.children].reverse());
    }

    return cloneData(observed);
}
