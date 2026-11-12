import { CapabilityId, ExecutionOutcome } from "../../../src/index.js";
import { equalContract, requireContract, stepAt, unchanged } from "../contracts.js";
import type { ReferenceCase } from "../types.js";

const lockEvents = ["RefStateLock", "RefStateBeforeLock", "RefStateAfterLock"];
const unlockEvents = ["RefStateUnlock", "RefStateBeforeUnlock", "RefStateAfterUnlock"];

export const stateEventCases: readonly ReferenceCase[] = [
    {
        id: "state-replacement-base-delegation",
        capabilities: [CapabilityId.StateActionReplacement, CapabilityId.Locks],
        steps: [
            {
                name: "lock",
                aml: '<Item type="RefStateRecord" action="lock" id="{{state-record}}" />',
            },
            {
                name: "unlock",
                aml: '<Item type="RefStateRecord" action="unlock" id="{{state-record}}" />',
            },
        ],

        check(observation) {
            const locked = stepAt(observation, 0);
            const unlocked = stepAt(observation, 1);
            equalContract(
                locked.events.map((event) => event.method),
                lockEvents,
                "The base lock invokes its native hooks without invoking its replacement twice.",
            );
            equalContract(
                unlocked.events.map((event) => event.method),
                unlockEvents,
                "The base unlock invokes its own native hooks.",
            );
            requireContract(
                Boolean(locked.response.items[0]?.properties.locked_by_id),
                "The lock is persisted.",
            );
            equalContract(
                unlocked.response.items[0]?.properties.locked_by_id,
                null,
                "The lock is cleared.",
            );
            equalContract(
                locked.events.at(-1)?.context.items[0]?.properties.name,
                "Original",
                "After-lock receives the stored response.",
            );
        },
    },
    {
        id: "state-replacement-explicit-suppression",
        capabilities: [CapabilityId.StateActionReplacement, CapabilityId.Locks],
        steps: [
            {
                name: "lock",
                aml: '<Item type="RefStateRecord" action="lock" id="{{state-record}}" serverEvents="0" />',
            },
            {
                name: "unlock",
                aml: '<Item type="RefStateRecord" action="unlock" id="{{state-record}}" serverEvents="0" />',
            },
        ],

        check(observation) {
            for (const step of observation.steps) {
                equalContract(
                    step.events,
                    [],
                    "Explicit suppression skips optional replacement and native hooks.",
                );
                equalContract(
                    step.outcome,
                    ExecutionOutcome.Committed,
                    "The native action still commits.",
                );
            }

            requireContract(
                Boolean(stepAt(observation, 0).response.items[0]?.properties.locked_by_id),
                "The suppressed lock still writes.",
            );
            equalContract(
                stepAt(observation, 1).response.items[0]?.properties.locked_by_id,
                null,
                "The suppressed unlock still writes.",
            );
        },
    },
    {
        id: "state-replacement-implicit-edit",
        capabilities: [
            CapabilityId.StateActionReplacement,
            CapabilityId.Locks,
            CapabilityId.Generations,
        ],
        steps: [
            {
                name: "edit",
                aml: '<Item type="RefStateRecord" action="edit" id="{{state-record}}" serverEvents="0"><name>Changed</name></Item>',
            },
        ],

        check(observation) {
            const step = stepAt(observation, 0);
            equalContract(
                step.events.map((event) => event.method),
                [
                    "RefStateBeforeLock",
                    "RefStateAfterLock",
                    "RefStateBeforeUnlock",
                    "RefStateAfterUnlock",
                    "RefStateBeforeUnlock",
                    "RefStateAfterUnlock",
                ],
                "Edit locks and cleanup retain ordinary hooks while bypassing replacements.",
            );
            equalContract(
                step.response.items[0]?.properties.generation,
                "2",
                "The edit versions normally.",
            );
            equalContract(
                step.response.items[0]?.properties.name,
                "Changed",
                "The business update is persisted.",
            );
            equalContract(
                step.response.items[0]?.properties.locked_by_id,
                null,
                "The new generation is unlocked.",
            );
        },
    },
    {
        id: "state-replacement-base-rollback",
        capabilities: [CapabilityId.StateActionReplacement, CapabilityId.Locks],
        steps: [
            {
                name: "reject",
                aml: '<Item type="RefStateRecord" action="lock" id="{{state-record}}"><name>Reject</name></Item>',
            },
        ],

        check(observation) {
            const step = stepAt(observation, 0);
            equalContract(
                step.outcome,
                ExecutionOutcome.RolledBack,
                "A replacement failure rolls back its base write.",
            );
            requireContract(
                step.response.error?.message.includes("Reference base lock rejected") === true,
                "The source failure reaches the caller.",
            );
            equalContract(
                step.events.map((event) => event.method),
                lockEvents,
                "The replacement fails after its base hooks ran.",
            );
            unchanged(observation);
        },
    },
];
