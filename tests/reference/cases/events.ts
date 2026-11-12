import { CapabilityId, ExecutionOutcome } from "../../../src/index.js";
import { equalContract, requireContract, stepAt, unchanged, valueAt } from "../contracts.js";
import type { ReferenceCase } from "../types.js";

export const eventCases: readonly ReferenceCase[] = [
    {
        id: "version-event-order",
        capabilities: [CapabilityId.ServerEvents, CapabilityId.Generations],
        steps: [
            {
                name: "edit",
                aml: '<Item type="RefDocument" action="edit" id="{{document}}"><name>Changed</name></Item>',
            },
        ],

        check(observation) {
            equalContract(
                stepAt(observation, 0).events.map((event) => event.event),
                [
                    "onBeforeLock",
                    "onAfterLock",
                    "onBeforeUpdate",
                    "onBeforeVersion",
                    "onBeforeUnlock",
                    "onAfterUnlock",
                    "onAfterVersion",
                    "onBeforeUpdate",
                    "onAfterUpdate",
                    "onBeforeUnlock",
                    "onAfterUnlock",
                ],
                "Version, update and lock events retain their order.",
            );
        },
    },
    {
        id: "required-events",
        capabilities: [CapabilityId.ServerEvents],
        steps: [
            {
                name: "edit",
                aml: '<Item type="RefRequired" action="edit" serverEvents="0" id="{{required}}"><name>Changed</name></Item>',
            },
        ],

        check(observation) {
            equalContract(
                stepAt(observation, 0).events.map((event) => event.method),
                ["RefRequiredUpdate"],
                "Required hooks execute while optional hooks are suppressed.",
            );
            equalContract(
                valueAt(observation, 0, "required_note"),
                "Required hook",
                "The required hook changes data.",
            );
            equalContract(
                valueAt(observation, 0, "note"),
                "Original note",
                "Optional hook stays suppressed.",
            );
        },
    },
    {
        id: "replacement-get",
        capabilities: [CapabilityId.ServerEvents],
        steps: [
            {
                name: "get",
                aml: '<Item type="RefReplacement" action="get" id="{{replacement}}" />',
            },
        ],

        check(observation) {
            equalContract(
                stepAt(observation, 0).events.map((event) => event.event),
                ["onGet"],
                "Replacement get suppresses standard before and after hooks.",
            );
            equalContract(
                valueAt(observation, 0, "name"),
                "Replacement response",
                "Replacement supplies the result.",
            );
            unchanged(observation);
        },
    },
    {
        id: "lifecycle-promotion",
        capabilities: [CapabilityId.Lifecycles, CapabilityId.ServerEvents],
        steps: [
            {
                name: "promote",
                aml: '<Item type="RefDocument" action="promoteItem" id="{{document}}"><state>Review</state></Item>',
            },
        ],

        check(observation) {
            equalContract(
                valueAt(observation, 0, "state"),
                "Review",
                "Promotion persists the target state.",
            );
            equalContract(
                valueAt(observation, 0, "generation"),
                "1",
                "Promotion does not version.",
            );
            equalContract(
                stepAt(observation, 0).events.map((event) => event.event),
                ["onBeforePromote", "pre_action", "onAfterPromote", "post_action"],
                "Transactional promotion hooks retain their order.",
            );
        },
    },
    {
        id: "promotion-rejection",
        capabilities: [CapabilityId.Lifecycles, CapabilityId.Generations],
        steps: [
            {
                name: "submit",
                aml: '<Item type="RefDocument" action="RefSubmitRejected" id="{{document}}" />',
            },
        ],

        check(observation) {
            equalContract(
                stepAt(observation, 0).outcome,
                ExecutionOutcome.RolledBack,
                "Rejection rolls back the request.",
            );
            requireContract(
                stepAt(observation, 0).response.error?.message.includes(
                    "Reference promotion rejected",
                ) === true,
                "The original rejection must reach the caller.",
            );
            unchanged(observation);
        },
    },
    {
        id: "caught-nested-csharp-failure",
        capabilities: [CapabilityId.CSharp, CapabilityId.ServerEvents],
        steps: [
            {
                name: "nested",
                aml: '<Item type="RefDocument" action="RefCatchNestedFailure" id="{{document}}"><plain>{{plain}}</plain></Item>',
            },
        ],

        check(observation) {
            equalContract(
                stepAt(observation, 0).outcome,
                ExecutionOutcome.RolledBack,
                "Caught nested failures still roll back.",
            );
            requireContract(
                stepAt(observation, 0).response.error?.message.includes(
                    "Reference update rejected",
                ) === true,
                "The nested update rejection must reach the caller.",
            );
            unchanged(observation);
        },
    },
];
