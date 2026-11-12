import { CapabilityId, ExecutionOutcome } from "../../../src/index.js";
import { equalContract, stepAt, valueAt } from "../contracts.js";
import type { ReferenceCase } from "../types.js";

export const boundPermissionCases: readonly ReferenceCase[] = [
    {
        id: "bound-method-inherited-nocheck",
        capabilities: [
            CapabilityId.ServerEvents,
            CapabilityId.NativePermissions,
            CapabilityId.CSharp,
        ],
        steps: [
            {
                name: "bound",
                aml: `<Item type="RefRequired" action="edit" id="{{required}}" serverEvents="0">
                    <name>Saved through the bound chain</name><note>Native NoCheck probe</note>
                </Item>`,
            },
            {
                name: "ordinary",
                aml: '<Item type="RefSecurityRecord" action="RefRestrictedMethod" />',
            },
        ],

        check(observation) {
            equalContract(
                valueAt(observation, 0, "required_note"),
                "Inherited NoCheck",
                "The restricted bound hook and its nested restricted Method execute.",
            );
            equalContract(
                stepAt(observation, 0).outcome,
                ExecutionOutcome.Committed,
                "The source-controlled update commits.",
            );
            equalContract(
                stepAt(observation, 1).response.error?.code,
                "PermissionDenied",
                "The next ordinary call still needs its execution identity.",
            );
            equalContract(
                stepAt(observation, 1).state,
                stepAt(observation, 0).state,
                "The denied ordinary Method cannot change data.",
            );
        },
    },
    {
        id: "bound-replacement-execution-restriction",
        capabilities: [
            CapabilityId.ServerEvents,
            CapabilityId.NativePermissions,
            CapabilityId.CSharp,
        ],
        steps: [
            {
                name: "bound",
                aml: '<Item type="RefReplacement" action="get" id="{{replacement}}" />',
            },
            {
                name: "ordinary",
                aml: '<Item type="RefReplacement" action="RefReplaceGet" id="{{replacement}}" />',
            },
        ],

        check(observation) {
            equalContract(
                valueAt(observation, 0, "name"),
                "Replacement response",
                "A restricted replacement Method executes through its native binding.",
            );
            equalContract(
                stepAt(observation, 1).response.error?.code,
                "PermissionDenied",
                "The same source cannot be invoked as an ordinary unauthorized Method.",
            );
            equalContract(
                stepAt(observation, 1).state,
                observation.initial,
                "Both calls preserve stored data.",
            );
        },
    },
];
