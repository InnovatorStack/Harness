import { CapabilityId, ExecutionOutcome } from "../../../src/index.js";
import { equalContract, stepAt, unchanged, valueAt } from "../contracts.js";
import type { ReferenceCase } from "../types.js";

export const baseDocumentCases: readonly ReferenceCase[] = [
    {
        id: "base-get-reloaded-document-and-captured-request",
        capabilities: [CapabilityId.CSharp, CapabilityId.ServerEvents, CapabilityId.Queries],
        steps: [
            {
                name: "get",
                aml: '<Item type="RefBaseDocument" action="get"><name>Requested</name></Item>',
            },
        ],

        check(observation) {
            const step = stepAt(observation, 0);

            equalContract(step.outcome, ExecutionOutcome.Committed, "The delegated Get succeeds.");
            equalContract(
                valueAt(observation, 0, "item_number"),
                "BASE-DOCUMENT-001",
                "The query retains its captured criteria after document replacement.",
            );
            equalContract(
                step.events.map((event) => event.method),
                ["RefDelegateDocument", "RefReloadBaseDocument", "RefInspectBaseDocument"],
                "Original Methods verify the retained input, current document and event order.",
            );
            unchanged(observation);
        },
    },
];
