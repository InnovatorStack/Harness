import { CapabilityId, ExecutionOutcome } from "../../../src/index.js";
import { equalContract, requireContract, resultId, stepAt } from "../contracts.js";
import type { ReferenceCase } from "../types.js";

export const copyLifecycleCases: readonly ReferenceCase[] = [
    {
        id: "copied-relationship-default-lifecycle",
        capabilities: [CapabilityId.RelationshipVersioning, CapabilityId.Lifecycles],
        steps: [
            {
                name: "link",
                aml: '<Item type="RefBatchLink" action="add"><source_id>{{batch-first}}</source_id><related_id>{{batch-second}}</related_id><label>Lifecycle copy</label></Item>',
            },
            {
                name: "working",
                aml: '<Item type="RefBatchLink" action="promoteItem" id="{{link}}"><state>Working</state></Item>',
            },
            {
                name: "parent",
                aml: '<Item type="RefBatch" action="version" id="{{batch-first}}" serverEvents="0" />',
            },
        ],

        check(observation) {
            const step = stepAt(observation, 2);
            equalContract(step.outcome, ExecutionOutcome.Committed, "Parent versioning commits.");
            const links = step.state.filter((record) => record.type === "RefBatchLink");
            const source = links.find((record) => record.id === resultId(observation, 0));
            const copied = links.find(
                (record) => record.properties.source_id === resultId(observation, 2),
            );
            requireContract(source !== undefined && copied !== undefined, "Both copies exist.");
            equalContract(source.properties.state, "Working", "Source state stays unchanged.");
            equalContract(source.properties.not_lockable, "1", "Source flags stay unchanged.");
            equalContract(copied.properties.state, "Draft", "The default lifecycle restarts.");
            equalContract(
                copied.properties.current_state,
                "A7810000000000000000000000000001",
                "The stored state points to the default map's start.",
            );
            equalContract(copied.properties.is_released, "0", "Release status resets.");
            equalContract(copied.properties.not_lockable, "0", "State lockability resets.");
            equalContract(
                copied.properties.permission_id,
                "A6000000000000000000000000000001",
                "The start-state Permission replaces the copied Permission.",
            );
            equalContract(
                source.properties.permission_id,
                "A6000000000000000000000000000008",
                "The source retains its working-state Permission.",
            );
            equalContract(copied.properties.config_id, copied.id, "Copies start new families.");
            equalContract(copied.properties.generation, "1", "Copies start at generation one.");
        },
    },
];
