import { CapabilityId, ExecutionOutcome } from "../../../src/index.js";
import { equalContract, stepAt, unchanged, valueAt } from "../contracts.js";
import type { ReferenceCase } from "../types.js";

export const capturedRequestCases: readonly ReferenceCase[] = [
    {
        id: "get-captured-criteria-after-document-reload",
        capabilities: [CapabilityId.CSharp, CapabilityId.ServerEvents, CapabilityId.Queries],
        steps: [
            {
                name: "get",
                aml: '<Item type="RefCapturedRecord" action="get"><name>Requested</name></Item>',
            },
        ],

        check(observation) {
            const step = stepAt(observation, 0);

            equalContract(step.outcome, ExecutionOutcome.Committed, "The Get succeeds.");
            equalContract(
                valueAt(observation, 0, "item_number"),
                "CAPTURED-001",
                "The query uses its captured criteria after detachment.",
            );
            equalContract(
                step.events.map((event) => event.method),
                ["RefReloadCapturedGet", "RefInspectCapturedGet"],
                "Both original Methods execute and verify independent document and node views.",
            );
            unchanged(observation);
        },
    },
];
