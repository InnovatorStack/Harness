import { CapabilityId, ExecutionOutcome } from "../../../src/index.js";
import { equalContract, stepAt, unchanged, valueAt } from "../contracts.js";
import type { ReferenceCase } from "../types.js";

export const sourceAccessCases: readonly ReferenceCase[] = [
    {
        id: "source-inherited-mutation-workflow",
        capabilities: [CapabilityId.NativePermissions, CapabilityId.Relationships],
        steps: [
            {
                name: "created",
                aml: `<Item type="RefSecurityLink" action="add" id="C7500000000000000000000000000001">
                    <source_id>{{team-manager}}</source_id><related_id>{{security-denied}}</related_id>
                    <label>Inherited creation</label>
                </Item>`,
            },
            {
                name: "edited",
                aml: '<Item type="RefSecurityLink" action="edit" id="C7500000000000000000000000000001"><label>Inherited edit</label></Item>',
            },
            {
                name: "fetched",
                aml: '<Item type="RefSecurityLink" action="get" id="C7500000000000000000000000000001" />',
            },
            {
                name: "removed",
                aml: '<Item type="RefSecurityLink" action="delete" id="C7500000000000000000000000000001" />',
            },
        ],

        check(observation) {
            for (const step of observation.steps) {
                equalContract(
                    step.outcome,
                    ExecutionOutcome.Committed,
                    "The inherited action commits.",
                );
            }

            equalContract(
                valueAt(observation, 0, "permission_id"),
                "A6000000000000000000000000000002",
                "Creation copies the source Permission.",
            );
            equalContract(
                valueAt(observation, 0, "team_id"),
                "B7200000000000000000000000000001",
                "Creation copies the source Team.",
            );
            equalContract(
                valueAt(observation, 2, "label"),
                "Inherited edit",
                "The edit is fetched from storage.",
            );
            unchanged(observation);
        },
    },
    {
        id: "source-acl-propagation",
        capabilities: [CapabilityId.NativePermissions, CapabilityId.Relationships],
        steps: [
            {
                name: "source",
                aml: `<Item type="RefSecurityRecord" action="edit" id="{{team-manager}}">
                    <permission_id>A6000000000000000000000000000001</permission_id>
                    <owned_by_id>A7100000000000000000000000000003</owned_by_id>
                </Item>`,
            },
            {
                name: "relationship",
                aml: '<Item type="RefSecurityLink" action="get" id="B7500000000000000000000000000001" />',
            },
        ],

        check(observation) {
            equalContract(
                valueAt(observation, 1, "permission_id"),
                "A6000000000000000000000000000001",
                "The propagated Permission is stored on the relationship.",
            );
            equalContract(
                valueAt(observation, 1, "owned_by_id"),
                "A7100000000000000000000000000003",
                "The changed owner is copied.",
            );
            equalContract(
                valueAt(observation, 1, "created_by_id"),
                "B1000000000000000000000000000002",
                "The relationship retains its own Creator.",
            );
            const row = stepAt(observation, 0).state.find(
                (record) => record.properties.label === "Protected related record",
            );
            equalContract(
                row?.properties.permission_id,
                valueAt(observation, 1, "permission_id"),
                "Raw stored state and the response agree.",
            );
        },
    },
    {
        id: "source-acl-propagation-rollback",
        capabilities: [CapabilityId.NativePermissions, CapabilityId.Relationships],
        steps: [
            {
                name: "reject",
                aml: `<AML>
                    <Item type="RefSecurityRecord" action="edit" id="{{team-manager}}">
                        <permission_id>A6000000000000000000000000000001</permission_id>
                    </Item>
                    <Item type="RefSecurityRecord" action="RefRestrictedMethod" />
                </AML>`,
            },
        ],

        check(observation) {
            equalContract(
                stepAt(observation, 0).response.error?.code,
                "PermissionDenied",
                "The later unauthorized Method rejects the batch.",
            );
            equalContract(
                stepAt(observation, 0).outcome,
                ExecutionOutcome.RolledBack,
                "The source edit and propagated ACL changes roll back together.",
            );
            unchanged(observation);
        },
    },
    {
        id: "source-owned-deletion",
        capabilities: [CapabilityId.NativePermissions, CapabilityId.Relationships],
        steps: [
            {
                name: "direct",
                aml: '<Item type="RefSecurityLink" action="delete" id="{{delete-child}}" />',
            },
            {
                name: "parent",
                aml: '<Item type="RefSecurityRecord" action="delete" id="{{delete-parent}}" />',
            },
        ],

        check(observation) {
            equalContract(
                stepAt(observation, 0).response.error?.code,
                "PermissionDenied",
                "Deleting a relationship directly requires Update access.",
            );
            equalContract(
                stepAt(observation, 0).state,
                observation.initial,
                "The rejected direct deletion leaves the graph intact.",
            );
            equalContract(
                stepAt(observation, 1).outcome,
                ExecutionOutcome.Committed,
                "Delete access authorizes the parent's owned cleanup.",
            );
            const remaining = stepAt(observation, 1).state;
            equalContract(
                remaining.some((record) => record.properties.item_number === "DELETE-PARENT"),
                false,
                "The parent is deleted.",
            );
            equalContract(
                remaining.some((record) => record.properties.label === "Owned deletion"),
                false,
                "Its relationship is deleted too.",
            );
        },
    },
];
