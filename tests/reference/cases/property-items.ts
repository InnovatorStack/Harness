import { CapabilityId, ExecutionOutcome } from "../../../src/index.js";
import { equalContract, requireContract, resultId, stepAt } from "../contracts.js";
import type { ReferenceCase } from "../types.js";

export const propertyItemCases: readonly ReferenceCase[] = ["TARGET-A", "TARGET-B"].map(
    (target) => ({
        id: target === "TARGET-A" ? "identical-property-item-copy" : "changed-property-item-copy",
        capabilities: [CapabilityId.CSharp, CapabilityId.ServerEvents, CapabilityId.Generations],
        steps: [
            {
                name: "edit",
                aml: `<Item type="RefPropertyRecord" action="edit" id="{{property-record}}">
                    <name>Saved</name><note>${target}</note><fixed_ref keyed_name="Keep">
                        <Item type="RefPropertyRecord" action="get"><item_number>TARGET-A</item_number></Item>
                    </fixed_ref></Item>`,
            },
        ],

        check(observation) {
            const step = stepAt(observation, 0);
            const saved = step.state.find((record) => record.id === resultId(observation, 0));
            const original = observation.initial.find(
                (record) => record.properties.item_number === "PROPERTY-001",
            );
            const expected = observation.initial.find(
                (record) => record.properties.item_number === target,
            );

            equalContract(step.outcome, ExecutionOutcome.Committed, "The update commits.");
            equalContract(
                saved?.properties.fixed_ref,
                expected?.id,
                "The imported child request resolves to the intended stored target.",
            );
            equalContract(saved?.properties.generation, "2", "The update creates one generation.");
            equalContract(saved?.properties.config_id, original?.id, "Configuration is retained.");
            equalContract(
                step.state.find((record) => record.id === original?.id),
                { ...original, properties: { ...original?.properties, is_current: "0" } },
                "History keeps its original property reference and business values.",
            );
            requireContract(
                step.events.some((event) => event.method === "RefPropertyUpdate"),
                "Original replacement source verifies retained and detached XML views.",
            );
        },
    }),
);
