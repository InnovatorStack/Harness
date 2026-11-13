import { CapabilityId, ExecutionOutcome } from "../../../src/index.js";
import { equalContract, resultId, stepAt, valueAt } from "../contracts.js";
import type { ReferenceCase } from "../types.js";

export const addIdentityCases: readonly ReferenceCase[] = [
    { id: "add-id-before-before-hook", attribute: "" },
    { id: "empty-add-id-before-before-hook", attribute: ' id=""' },
].map(({ id, attribute }) => ({
    id,
    capabilities: [CapabilityId.ItemActions, CapabilityId.ServerEvents, CapabilityId.CSharp],
    steps: [
        {
            name: "add",
            aml: `<Item type="RefAddRecord" action="add"${attribute}><item_number>ADD-ID-001</item_number></Item>`,
        },
    ],

    check(observation) {
        const step = stepAt(observation, 0);
        const id = resultId(observation, 0);
        const stored = step.state.find((record) => record.type === "RefAddRecord");

        equalContract(step.outcome, ExecutionOutcome.Committed, "The default Add succeeds.");
        equalContract(
            valueAt(observation, 0, "note"),
            "Allocated before hook",
            "The original before-hook ran with its allocated ID.",
        );
        equalContract(stored?.id, id, "The result identifies the inserted record.");
        equalContract(stored?.properties.config_id, id, "The configuration starts with that ID.");
        equalContract(
            step.events.map((event) => event.method),
            ["RefDelegateAddIdentity", "RefInspectAddIdentity"],
            "The replacement runs before default allocation and the before-hook runs after it.",
        );
    },
}));
