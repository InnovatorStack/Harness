import { CapabilityId, ExecutionOutcome } from "../../../src/index.js";
import { equalContract, stepAt, unchanged, valueAt } from "../contracts.js";
import type { ReferenceCase } from "../types.js";

export const reclassificationCases: readonly ReferenceCase[] = [
    {
        id: "class-change-preserves-shared-map-state",
        capabilities: [CapabilityId.Lifecycles, CapabilityId.NativePermissions],
        steps: [
            {
                name: "changed",
                aml: '<Item type="RefClassified" action="edit" id="{{class-advanced}}"><classification>Technical/Manufactured</classification></Item>',
            },
        ],

        check(observation) {
            equalContract(
                valueAt(observation, 0, "classification"),
                "Technical/Manufactured",
                "The class changes.",
            );
            equalContract(
                valueAt(observation, 0, "state"),
                "Technical review",
                "A shared map retains its progressed state.",
            );
            equalContract(
                stepAt(observation, 0).outcome,
                ExecutionOutcome.Committed,
                "The update commits.",
            );
        },
    },
    {
        id: "class-change-requires-creation-rights",
        capabilities: [CapabilityId.NativePermissions],
        steps: [
            {
                name: "reject",
                aml: '<Item type="RefClassified" action="edit" id="{{class-start}}"><classification>Commercial</classification></Item>',
            },
        ],

        check(observation) {
            equalContract(
                stepAt(observation, 0).response.error?.code,
                "PermissionDenied",
                "Update does not imply Can Add for the target class.",
            );
            equalContract(
                stepAt(observation, 0).outcome,
                ExecutionOutcome.RolledBack,
                "The denied class change rolls back.",
            );
            unchanged(observation);
        },
    },
    {
        id: "class-map-change-requires-start-state",
        capabilities: [CapabilityId.Lifecycles, CapabilityId.NativePermissions],
        steps: [
            {
                name: "reject",
                aml: '<Item type="RefClassified" action="edit" id="{{class-advanced}}"><classification>Commercial</classification></Item>',
            },
        ],

        check(observation) {
            equalContract(
                stepAt(observation, 0).response.error?.code,
                "ClassificationCannotBeChanged",
                "The old map's progressed state rejects a map switch.",
            );
            equalContract(
                stepAt(observation, 0).outcome,
                ExecutionOutcome.RolledBack,
                "The lifecycle rejection rolls back.",
            );
            unchanged(observation);
        },
    },
    {
        id: "class-map-change-with-scoped-grant",
        capabilities: [
            CapabilityId.Lifecycles,
            CapabilityId.NativePermissions,
            CapabilityId.CSharp,
        ],
        steps: [
            {
                name: "changed",
                aml: '<Item type="RefClassified" action="RefReclassifyWithGrant" id="{{class-start}}" />',
            },
            {
                name: "restored",
                aml: '<Item type="RefClassified" action="edit" id="{{class-root}}"><classification>Commercial</classification></Item>',
            },
        ],

        check(observation) {
            equalContract(
                valueAt(observation, 0, "classification"),
                "Commercial",
                "The scoped grant permits the target class.",
            );
            equalContract(
                valueAt(observation, 0, "state"),
                "Commercial draft",
                "The new map supplies its start state.",
            );
            equalContract(
                valueAt(observation, 0, "permission_id"),
                "A7620000000000000000000000000001",
                "The state supplies its Permission.",
            );
            equalContract(
                stepAt(observation, 1).response.error?.code,
                "PermissionDenied",
                "The temporary class grant expires.",
            );
            equalContract(
                stepAt(observation, 1).state,
                stepAt(observation, 0).state,
                "The later rejection retains the committed change.",
            );
        },
    },
    {
        id: "class-branch-value-is-invalid",
        capabilities: [CapabilityId.ItemActions],
        steps: [
            {
                name: "reject",
                aml: '<Item type="RefClassified" action="edit" id="{{class-start}}"><classification>Technical</classification></Item>',
            },
        ],

        check(observation) {
            equalContract(
                stepAt(observation, 0).response.error?.code,
                "InvalidClassification",
                "A branch grant does not make the branch an assignable Item class.",
            );
            equalContract(
                stepAt(observation, 0).outcome,
                ExecutionOutcome.RolledBack,
                "Invalid class values roll back.",
            );
            unchanged(observation);
        },
    },
    {
        id: "unchanged-class-needs-no-creation-grant",
        capabilities: [CapabilityId.NativePermissions, CapabilityId.ItemActions],
        steps: [
            {
                name: "saved",
                aml: '<Item type="RefClassified" action="edit" id="{{class-root}}"><classification></classification><name>Existing class saved</name></Item>',
            },
        ],

        check(observation) {
            equalContract(
                stepAt(observation, 0).outcome,
                ExecutionOutcome.Committed,
                "Update rights suffice for an unchanged class.",
            );
            equalContract(
                valueAt(observation, 0, "name"),
                "Existing class saved",
                "The edit persists.",
            );
            equalContract(
                valueAt(observation, 0, "classification"),
                "",
                "The root class remains unchanged.",
            );
        },
    },
];
