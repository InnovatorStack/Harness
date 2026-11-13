import { CapabilityId, ExecutionOutcome } from "../../../src/index.js";
import {
    equalContract,
    requireContract,
    resultId,
    stepAt,
    unchanged,
    valueAt,
} from "../contracts.js";
import type { ReferenceCase } from "../types.js";

export const eventResultCases: readonly ReferenceCase[] = [
    {
        id: "shared-event-input",
        capabilities: [CapabilityId.ServerEvents, CapabilityId.Generations, CapabilityId.CSharp],
        steps: [
            {
                name: "edit",
                aml: `<Item type="RefEventRecord" action="edit" id="{{event-record}}">
                    <name>Requested</name><note>Permitted</note></Item>`,
            },
        ],

        check(observation) {
            const step = stepAt(observation, 0);
            const id = resultId(observation, 0);
            const saved = step.state.find((record) => record.id === id);
            const original = observation.initial.find((record) => record.type === "RefEventRecord");

            equalContract(step.outcome, ExecutionOutcome.Committed, "The update commits.");
            equalContract(valueAt(observation, 0, "generation"), "2", "The update versions.");
            equalContract(
                valueAt(observation, 0, "name"),
                "Hydrated input",
                "After-Get modifies the actual response input.",
            );
            equalContract(
                saved?.properties.name,
                "Validated input",
                "Before-version hooks share input without adopting separate responses.",
            );
            equalContract(saved?.properties.note, "Permitted", "Other requested fields persist.");
            equalContract(
                saved?.properties.config_id,
                original?.id,
                "The new generation retains configuration identity.",
            );
            equalContract(
                step.state.find((record) => record.id === original?.id)?.properties.name,
                "Original",
                "Historical values stay unchanged.",
            );
            requireContract(id !== original?.id, "The generation receives a new ID.");
        },
    },
    {
        id: "zero-code-event-rejection",
        capabilities: [CapabilityId.ServerEvents, CapabilityId.Generations, CapabilityId.CSharp],
        steps: [
            {
                name: "edit",
                aml: `<Item type="RefEventRecord" action="edit" id="{{event-record}}">
                    <name>Requested</name><note>Reject zero</note></Item>`,
            },
        ],

        check(observation) {
            const step = stepAt(observation, 0);
            equalContract(step.response.error?.code, "0", "The hook returns a no-items fault.");
            equalContract(
                step.outcome,
                ExecutionOutcome.RolledBack,
                "Any hook fault rejects the transaction, including code zero.",
            );
            requireContract(
                step.events.some((event) => event.method === "RefEventRejectZero"),
                "The original rejecting hook executes.",
            );
            unchanged(observation);
        },
    },
    {
        id: "null-method-response",
        capabilities: [CapabilityId.CSharp],
        steps: [
            {
                name: "invoke",
                aml: `<Item type="RefEventRecord" action="RefEventReturnNull" id="{{event-record}}">
                    <name>Requested</name></Item>`,
            },
        ],

        check(observation) {
            const step = stepAt(observation, 0);
            equalContract(step.response.items, [], "A null return does not echo the input Item.");
            equalContract(step.response.result, "", "A null return supplies an empty Result.");
            equalContract(step.outcome, ExecutionOutcome.Committed, "The Method succeeds.");
            unchanged(observation);
        },
    },
];
