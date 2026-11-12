import { CapabilityId, ExecutionOutcome } from "../../../src/index.js";
import { equalContract, requireContract, resultId, stepAt, valueAt } from "../contracts.js";
import type { ReferenceCase } from "../types.js";

export const historicalUnlockCases: readonly ReferenceCase[] = [
    {
        id: "locked-source-version-unlock",
        capabilities: [CapabilityId.Locks, CapabilityId.Generations, CapabilityId.ServerEvents],
        steps: [
            {
                name: "lock",
                aml: '<Item type="RefDocument" action="lock" id="{{document}}" doGetItem="0" />',
            },
            {
                name: "version",
                aml: '<Item type="RefDocument" action="version" id="{{document}}"><name>Versioned</name></Item>',
            },
        ],

        check(observation) {
            const step = stepAt(observation, 1);
            equalContract(
                step.events.map((event) => event.event),
                [
                    "onBeforeVersion",
                    "onBeforeUnlock",
                    "onAfterUnlock",
                    "onAfterVersion",
                    "onBeforeUpdate",
                    "onAfterUpdate",
                ],
                "The historical unlock precedes after-version and generated updates.",
            );
            const previous = step.state.find(
                (record) =>
                    record.properties.item_number === "DOC-001" &&
                    record.properties.generation === "1",
            );
            equalContract(
                previous?.properties.locked_by_id,
                null,
                "The historical lock is cleared.",
            );
            equalContract(
                previous?.properties.new_version,
                "0",
                "Unlock resets the automatic marker.",
            );
            requireContract(
                Boolean(valueAt(observation, 1, "locked_by_id")),
                "The new generation stays locked.",
            );
            requireContract(
                resultId(observation, 1) !== previous?.id,
                "The new generation has a new ID.",
            );
        },
    },
    {
        id: "unlocked-source-version",
        capabilities: [CapabilityId.Locks, CapabilityId.Generations, CapabilityId.ServerEvents],
        steps: [
            {
                name: "version",
                aml: '<Item type="RefDocument" action="version" id="{{document}}" />',
            },
        ],

        check(observation) {
            equalContract(
                stepAt(observation, 0).events.filter((event) => event.event.endsWith("Unlock")),
                [],
                "An unlocked source needs no historical unlock callbacks.",
            );
            requireContract(
                Boolean(valueAt(observation, 0, "locked_by_id")),
                "The generated item is locked.",
            );
            equalContract(
                valueAt(observation, 0, "generation"),
                "2",
                "Explicit version still creates a generation.",
            );
        },
    },
    {
        id: "suppressed-edit-internal-unlocks",
        capabilities: [CapabilityId.Locks, CapabilityId.Generations, CapabilityId.ServerEvents],
        steps: [
            {
                name: "edit",
                aml: '<Item type="RefDocument" action="edit" serverEvents="0" id="{{document}}"><name>Saved</name></Item>',
            },
        ],

        check(observation) {
            equalContract(
                stepAt(observation, 0).events.map((event) => event.event),
                [
                    "onBeforeLock",
                    "onAfterLock",
                    "onBeforeVersion",
                    "onBeforeUnlock",
                    "onAfterUnlock",
                    "onAfterVersion",
                    "onBeforeUnlock",
                    "onAfterUnlock",
                ],
                "Internal unlock and version hooks survive suppression of optional update events.",
            );
            equalContract(
                valueAt(observation, 0, "locked_by_id"),
                null,
                "Edit unlocks its result.",
            );
        },
    },
    {
        id: "historical-unlock-rejection",
        capabilities: [CapabilityId.Locks, CapabilityId.Generations, CapabilityId.ServerEvents],
        steps: [
            {
                name: "lock",
                aml: '<Item type="RefDocument" action="lock" id="{{document}}" doGetItem="0" />',
            },
            {
                name: "prepare",
                aml: '<Item type="RefDocument" action="update" version="0" serverEvents="0" id="{{document}}"><note>Reject historical unlock</note></Item>',
            },
            {
                name: "version",
                aml: '<Item type="RefDocument" action="version" id="{{document}}" />',
            },
        ],

        check(observation) {
            const step = stepAt(observation, 2);
            equalContract(
                step.outcome,
                ExecutionOutcome.RolledBack,
                "The rejection rolls back versioning.",
            );
            requireContract(
                step.response.error?.message.includes("Reference historical unlock rejected") ===
                    true,
                "The original Method error is retained.",
            );
            equalContract(
                step.state,
                stepAt(observation, 1).state,
                "The source values and lock remain unchanged.",
            );
        },
    },
];
