import { CapabilityId, ExecutionOutcome } from "../../../src/index.js";
import { equalContract, stepAt, unchanged } from "../contracts.js";
import type { ReferenceCase } from "../types.js";

export const documentViewCases: readonly ReferenceCase[] = [
    {
        id: "shared-document-retained-views",
        capabilities: [CapabilityId.CSharp],
        steps: [
            {
                name: "invoke",
                aml: '<Item type="RefPlain" action="RefDocumentReloadViews" />',
            },
        ],

        check(observation) {
            const step = stepAt(observation, 0);

            equalContract(step.outcome, ExecutionOutcome.Committed, "The Method succeeds.");
            equalContract(
                step.response.result,
                "Document views verified",
                "Original source verifies document reloads, scalar edits and self-insertion.",
            );
            unchanged(observation);
        },
    },
    {
        id: "selected-item-document-return",
        capabilities: [CapabilityId.CSharp],
        steps: [
            {
                name: "invoke",
                aml: '<Item type="RefPlain" action="RefDocumentReturnSelection" />',
            },
        ],

        check(observation) {
            const step = stepAt(observation, 0);

            equalContract(step.outcome, ExecutionOutcome.Committed, "The Method succeeds.");
            equalContract(
                step.response.items.map((item) => item.properties.name),
                ["First", "Second"],
                "The native template returns the selected Item's whole document.",
            );
            unchanged(observation);
        },
    },
];
