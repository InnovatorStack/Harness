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

export const actionCases: readonly ReferenceCase[] = [
    {
        id: "nonversionable-edit",
        capabilities: [CapabilityId.ItemActions],
        steps: [
            {
                name: "edit",
                aml: '<Item type="RefPlain" action="edit" id="{{plain}}"><name>Changed</name></Item>',
            },
        ],

        check(observation) {
            equalContract(
                valueAt(observation, 0, "name"),
                "Changed",
                "Edit must persist its values.",
            );
            const initial = observation.initial.find((record) => record.type === "RefPlain");
            equalContract(
                resultId(observation, 0),
                initial?.id,
                "A nonversionable edit retains ID.",
            );
        },
    },
    {
        id: "nullable-clear-and-empty",
        capabilities: [CapabilityId.ItemActions],
        steps: [
            {
                name: "clear",
                aml: '<Item type="RefPlain" action="edit" id="{{plain}}"><note is_null="1" /></Item>',
            },
            {
                name: "empty",
                aml: '<Item type="RefPlain" action="edit" id="{{plain}}"><note></note></Item>',
            },
        ],

        check(observation) {
            equalContract(
                valueAt(observation, 0, "note"),
                null,
                "Explicit null must clear the value.",
            );
            equalContract(
                valueAt(observation, 1, "note"),
                "",
                "Empty text remains distinguishable.",
            );
        },
    },
    {
        id: "required-property-rejection",
        capabilities: [CapabilityId.ItemActions],
        steps: [
            {
                name: "reject",
                aml: '<Item type="RefPlain" action="edit" id="{{plain}}"><item_number is_null="1" /></Item>',
            },
        ],

        check(observation) {
            equalContract(
                stepAt(observation, 0).outcome,
                ExecutionOutcome.RolledBack,
                "Required property rejection rolls back.",
            );
            requireContract(
                stepAt(observation, 0).response.error !== undefined,
                "A missing required value must fail.",
            );
            equalContract(
                stepAt(observation, 0).response.error?.code,
                "RequiredProperty",
                "Requiredness must cause the rejection.",
            );
            unchanged(observation);
        },
    },
    {
        id: "lock-ownership",
        capabilities: [CapabilityId.Locks],
        steps: [{ name: "lock", aml: '<Item type="RefDocument" action="lock" id="{{locked}}" />' }],

        check(observation) {
            equalContract(
                stepAt(observation, 0).outcome,
                ExecutionOutcome.RolledBack,
                "Another owner's lock must reject.",
            );
            equalContract(
                stepAt(observation, 0).response.error?.code,
                "LockOwnership",
                "Lock ownership must cause the rejection.",
            );
            unchanged(observation);
        },
    },
];
