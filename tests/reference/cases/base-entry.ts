import { CapabilityId, ExecutionOutcome } from "../../../src/index.js";
import { equalContract, stepAt, unchanged, valueAt } from "../contracts.js";
import type { ReferenceCase } from "../types.js";

export const baseEntryCases: readonly ReferenceCase[] = [
    {
        id: "base-get-input-reloaded-before-entry",
        capabilities: [CapabilityId.CSharp, CapabilityId.ServerEvents, CapabilityId.Queries],
        steps: [
            {
                name: "get",
                aml: '<Item type="RefEntryGet" action="get"><item_number>ENTRY-001</item_number><name>Requested</name></Item>',
            },
        ],

        check(observation) {
            const step = stepAt(observation, 0);

            equalContract(step.outcome, ExecutionOutcome.Committed, "The captured Get succeeds.");
            equalContract(
                valueAt(observation, 0, "item_number"),
                "ENTRY-001",
                "BaseGet queries the element captured before the replacement reloaded its input.",
            );
            equalContract(
                step.events.map((event) => event.method),
                ["RefReloadEntryGet", "RefInspectEntryGet"],
                "Original Methods verify distinct captured input and live document views.",
            );
            unchanged(observation);
        },
    },
];
