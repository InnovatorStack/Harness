import { CapabilityId, ExecutionOutcome } from "../../../src/index.js";
import { equalContract, requireContract, resultId, stepAt, valueAt } from "../contracts.js";
import type { ReferenceCase } from "../types.js";

export const actionResponseCases: readonly ReferenceCase[] = [
    {
        id: "minimal-write-response",
        capabilities: [
            CapabilityId.ItemActions,
            CapabilityId.Generations,
            CapabilityId.ServerEvents,
        ],
        steps: [
            {
                name: "saved",
                aml: '<Item type="RefDocument" action="edit" id="{{document}}" doGetItem="0"><name>Minimal save</name></Item>',
            },
            {
                name: "fetched",
                aml: '<Item type="RefDocument" action="get" id="{{saved}}" doGetItem="0" />',
            },
        ],

        check(observation) {
            equalContract(
                stepAt(observation, 0).response.items[0]?.properties,
                {},
                "A minimal write returns no properties.",
            );
            equalContract(resultId(observation, 0), resultId(observation, 1), "The ID resolves.");
            equalContract(valueAt(observation, 1, "name"), "Minimal save", "The write persists.");
            equalContract(valueAt(observation, 1, "generation"), "2", "The edit still versions.");
            equalContract(
                stepAt(observation, 0).events.map((event) => event.event),
                [
                    "onBeforeLock",
                    "onAfterLock",
                    "onBeforeVersion",
                    "onAfterVersion",
                    "onBeforeUpdate",
                    "onAfterUpdate",
                    "onBeforeUnlock",
                    "onAfterUnlock",
                ],
                "Suppressing result retrieval must retain mutation hooks.",
            );
        },
    },
    {
        id: "minimal-lock-acknowledgements",
        capabilities: [CapabilityId.Locks, CapabilityId.ServerEvents],
        steps: [
            {
                name: "locked",
                aml: '<Item type="RefDocument" action="lock" id="{{document}}" doGetItem="0" />',
            },
            {
                name: "unlocked",
                aml: '<Item type="RefDocument" action="unlock" id="{{document}}" doGetItem="0" />',
            },
        ],

        check(observation) {
            for (const index of [0, 1]) {
                const step = stepAt(observation, index);
                equalContract(step.response.result, "Ok.", "Lock actions return a message.");
                equalContract(step.response.items, [], "The acknowledgement contains no Items.");
                equalContract(step.outcome, ExecutionOutcome.Committed, "The action commits.");
            }

            const locked = stepAt(observation, 0).state.find(
                (record) => record.properties.item_number === "DOC-001",
            );
            const unlocked = stepAt(observation, 1).state.find(
                (record) => record.properties.item_number === "DOC-001",
            );
            requireContract(Boolean(locked?.properties.locked_by_id), "The lock persists.");
            equalContract(unlocked?.properties.locked_by_id, null, "Unlock clears its owner.");
        },
    },
    {
        id: "mutation-return-get",
        capabilities: [CapabilityId.ItemActions, CapabilityId.ServerEvents],
        steps: [
            {
                name: "full",
                aml: '<Item type="RefReplacement" action="edit" id="{{replacement}}"><name>Stored full</name></Item>',
            },
            {
                name: "minimal",
                aml: '<Item type="RefReplacement" action="edit" id="{{replacement}}" doGetItem="0"><name>Stored minimal</name></Item>',
            },
        ],

        check(observation) {
            equalContract(
                valueAt(observation, 0, "name"),
                "Replacement response",
                "The full mutation result invokes the imported Get replacement.",
            );
            equalContract(
                stepAt(observation, 0).events.map((event) => event.event),
                ["onGet"],
                "Get replacement owns the return retrieval.",
            );
            const full = stepAt(observation, 0).state.find(
                (record) => record.properties.item_number === "REPLACEMENT-001",
            );
            equalContract(
                full?.properties.name,
                "Stored full",
                "Calculated output is not persisted.",
            );
            equalContract(stepAt(observation, 1).events, [], "Minimal results skip Get.");
            equalContract(
                stepAt(observation, 1).response.items[0]?.properties,
                {},
                "Only the ID returns.",
            );
            const minimal = stepAt(observation, 1).state.find(
                (record) => record.properties.item_number === "REPLACEMENT-001",
            );
            equalContract(minimal?.properties.name, "Stored minimal", "The second save persists.");
        },
    },
    {
        id: "delete-acknowledgement",
        capabilities: [CapabilityId.ItemActions],
        steps: [
            {
                name: "deleted",
                aml: '<Item type="RefPlain" action="delete" id="{{plain}}" />',
            },
        ],

        check(observation) {
            const step = stepAt(observation, 0);
            equalContract(step.response.result, "Ok", "Delete returns its native message.");
            equalContract(step.response.items, [], "Deleted records are not returned as Items.");
            equalContract(step.outcome, ExecutionOutcome.Committed, "Deletion commits.");
            requireContract(
                !step.state.some((record) => record.properties.item_number === "PLAIN-001"),
                "The acknowledged record must be deleted.",
            );
        },
    },
];
