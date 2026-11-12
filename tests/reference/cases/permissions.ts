import { CapabilityId, ExecutionOutcome } from "../../../src/index.js";
import { equalContract, stepAt, unchanged, valueAt } from "../contracts.js";
import type { ReferenceCase } from "../types.js";

export const permissionCases: readonly ReferenceCase[] = [
    {
        id: "permission-filter-and-owner",
        capabilities: [CapabilityId.NativePermissions],
        steps: [
            {
                name: "visible",
                aml: `<Item type="RefSecurityRecord" action="get" select="item_number" orderBy="item_number">
                    <or><item_number>PUBLIC</item_number><item_number>HIDDEN</item_number>
                    <item_number>OWNER</item_number><item_number>OTHER-OWNER</item_number></or>
                </Item>`,
            },
            {
                name: "owned",
                aml: '<Item type="RefSecurityRecord" action="edit" id="{{security-owner}}"><name>Owned change</name></Item>',
            },
        ],

        check(observation) {
            equalContract(
                stepAt(observation, 0).response.items.map((item) => item.properties.item_number),
                ["OWNER", "PUBLIC"],
                "ACLs include public data and the actor's own record while excluding other owners.",
            );
            equalContract(
                valueAt(observation, 1, "name"),
                "Owned change",
                "Owner rights permit the edit.",
            );
        },
    },
    {
        id: "permission-batch-rejection",
        capabilities: [CapabilityId.NativePermissions, CapabilityId.ItemActions],
        steps: [
            {
                name: "reject",
                aml: `<AML>
                    <Item type="RefPlain" action="edit" id="{{plain}}"><name>Must roll back</name></Item>
                    <Item type="RefSecurityRecord" action="edit" id="{{security-denied}}"><name>Forbidden</name></Item>
                </AML>`,
            },
        ],

        check(observation) {
            equalContract(
                stepAt(observation, 0).outcome,
                ExecutionOutcome.RolledBack,
                "A denied edit rolls back its batch.",
            );
            equalContract(
                stepAt(observation, 0).response.error?.code,
                "PermissionDenied",
                "ACLs cause the rejection.",
            );
            unchanged(observation);
        },
    },
    {
        id: "permission-access-change-rejection",
        capabilities: [CapabilityId.NativePermissions],
        steps: [
            {
                name: "reject",
                aml: `<Item type="RefSecurityRecord" action="edit" id="{{access-change}}">
                    <permission_id>A6000000000000000000000000000001</permission_id>
                </Item>`,
            },
        ],

        check(observation) {
            equalContract(
                stepAt(observation, 0).response.error?.code,
                "PermissionDenied",
                "Update rights do not imply change-access rights.",
            );
            equalContract(
                stepAt(observation, 0).outcome,
                ExecutionOutcome.RolledBack,
                "The edit and implicit lock roll back.",
            );
            unchanged(observation);
        },
    },
    {
        id: "permission-access-change-success",
        capabilities: [CapabilityId.NativePermissions],
        steps: [
            {
                name: "changed",
                aml: `<Item type="RefSecurityRecord" action="edit" id="{{team-manager}}">
                    <permission_id>A6000000000000000000000000000001</permission_id>
                </Item>`,
            },
        ],

        check(observation) {
            equalContract(
                stepAt(observation, 0).outcome,
                ExecutionOutcome.Committed,
                "A team manager may select an allowed Permission.",
            );
            equalContract(
                valueAt(observation, 0, "permission_id"),
                "A6000000000000000000000000000001",
                "The selected Permission is returned.",
            );
            const record = stepAt(observation, 0).state.find(
                (item) => item.properties.item_number === "TEAM-02",
            );
            equalContract(
                record?.properties.permission_id,
                valueAt(observation, 0, "permission_id"),
                "The selected Permission is actually stored.",
            );
        },
    },
    {
        id: "permission-can-add-disabled",
        capabilities: [CapabilityId.NativePermissions, CapabilityId.ItemActions],
        steps: [
            {
                name: "reject",
                aml: '<Item type="RefNoAdd" action="add"><item_number>DENIED</item_number></Item>',
            },
            {
                name: "created",
                aml: '<Item type="RefSecurityRecord" action="add"><item_number>CREATED</item_number><name>Permitted</name></Item>',
            },
        ],

        check(observation) {
            equalContract(
                stepAt(observation, 0).response.error?.code,
                "PermissionDenied",
                "A disabled World rule and another user's rule cannot authorize creation.",
            );
            equalContract(
                stepAt(observation, 0).outcome,
                ExecutionOutcome.RolledBack,
                "Rejected creation cannot persist data.",
            );
            equalContract(
                stepAt(observation, 0).state,
                observation.initial,
                "The rejected creation leaves the complete graph unchanged.",
            );
            equalContract(
                valueAt(observation, 1, "permission_id"),
                "A6000000000000000000000000000001",
                "Permitted creation uses the exported default Permission.",
            );
            equalContract(
                valueAt(observation, 1, "state"),
                "Draft",
                "Permitted creation starts the imported lifecycle.",
            );
        },
    },
    {
        id: "permission-method-execution",
        capabilities: [CapabilityId.NativePermissions, CapabilityId.CSharp],
        steps: [
            {
                name: "reject",
                aml: '<Item type="RefSecurityRecord" action="RefRestrictedMethod" />',
            },
        ],

        check(observation) {
            equalContract(
                stepAt(observation, 0).response.error?.code,
                "PermissionDenied",
                "Execution identity checks reject the original Method.",
            );
            equalContract(
                stepAt(observation, 0).outcome,
                ExecutionOutcome.RolledBack,
                "Unauthorized execution cannot commit.",
            );
            unchanged(observation);
        },
    },
    {
        id: "permission-scoped-grant",
        capabilities: [CapabilityId.NativePermissions, CapabilityId.CSharp],
        steps: [
            {
                name: "granted",
                aml: '<Item type="RefSecurityRecord" action="RefReadWithGrant" />',
            },
            {
                name: "restored",
                aml: '<Item type="RefSecurityRecord" action="get"><item_number>HIDDEN</item_number></Item>',
            },
        ],

        check(observation) {
            equalContract(
                valueAt(observation, 0, "item_number"),
                "HIDDEN",
                "The original C# grant authorizes its nested query.",
            );
            equalContract(
                stepAt(observation, 1).response.items.length,
                0,
                "The scoped identity cannot leak into the next request.",
            );
            unchanged(observation);
        },
    },
    {
        id: "permission-source-access",
        capabilities: [CapabilityId.NativePermissions, CapabilityId.Relationships],
        steps: [
            {
                name: "relationship",
                aml: '<Item type="RefSecurityLink" action="get" select="source_id(item_number),related_id(item_number),label" />',
            },
        ],

        check(observation) {
            const items = stepAt(observation, 0).response.items;
            equalContract(items.length, 1, "The relationship uses its source ACL and Team.");
            equalContract(
                items[0]?.propertyItems.source_id?.properties.item_number,
                "TEAM-02",
                "The readable source is expanded.",
            );
            equalContract(
                items[0]?.propertyItems.related_id,
                undefined,
                "The protected related Item remains unexpanded.",
            );
            const target = observation.initial.find(
                (item) => item.properties.item_number === "HIDDEN",
            );
            equalContract(
                items[0]?.properties.related_id,
                target?.id,
                "The related reference retains its actual ID.",
            );
            unchanged(observation);
        },
    },
];
