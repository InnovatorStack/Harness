import { CapabilityId, ExecutionOutcome } from "../../../src/index.js";
import { equalContract, requireContract, resultId, stepAt, valueAt } from "../contracts.js";
import type { ReferenceCase } from "../types.js";

export const requestOriginCases: readonly ReferenceCase[] = [false, true].map((repeated) => {
    const attributes = repeated ? 'action="edit" id="{{origin-link}}"' : 'action="add"';

    return {
        id: repeated ? "repeated-request-origins" : "anonymous-request-origins",
        capabilities: [CapabilityId.ServerEvents, CapabilityId.Generations, CapabilityId.CSharp],
        steps: [
            {
                name: "lock",
                aml: '<Item type="RefOriginRecord" action="lock" id="{{origin-record}}" />',
            },
            {
                name: "save",
                aml: `<Item type="RefOriginRecord" action="update" id="{{origin-record}}">
                    <name>Saved</name><Relationships>
                        <Item type="RefOriginLink" ${attributes}><label>First</label></Item>
                        <Item type="RefOriginLink" ${attributes}><label>Original</label></Item>
                    </Relationships></Item>`,
            },
        ],

        check(observation) {
            const step = stepAt(observation, 1);
            equalContract(
                valueAt(observation, 1, "note"),
                "Origins verified",
                "Source verified retained XML views.",
            );
            equalContract(
                valueAt(observation, 1, "generation"),
                "2",
                "The update creates one generation.",
            );
            equalContract(
                step.outcome,
                ExecutionOutcome.Committed,
                "The delegated action commits.",
            );
            const id = resultId(observation, 1);
            const links = step.state.filter(
                (record) => record.type === "RefOriginLink" && record.properties.source_id === id,
            );

            equalContract(
                links
                    .map((record) => record.properties.label)
                    .sort((left, right) => String(left).localeCompare(String(right), "en")),
                repeated ? ["Changed"] : ["Changed", "Existing", "Original"],
                "Ordered writes use the mutated request while preserving existing links.",
            );
            requireContract(
                step.state.find((record) => record.id === id)?.properties.note !==
                    "Origins verified",
                "The verification marker stays in the response.",
            );
        },
    };
});
