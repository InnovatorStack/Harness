import { CapabilityId, ExecutionOutcome } from "../../../src/index.js";
import { equalContract, stepAt, unchanged, valueAt } from "../contracts.js";
import type { ReferenceCase } from "../types.js";

export const teamCases: readonly ReferenceCase[] = [
    {
        id: "team-role-paging",
        capabilities: [CapabilityId.NativePermissions, CapabilityId.Queries],
        steps: [
            {
                name: "first-page",
                aml: `<Item type="RefSecurityRecord" action="get" select="item_number" orderBy="item_number" pagesize="2" page="1">
                    <item_number condition="like">TEAM-%</item_number>
                </Item>`,
            },
            {
                name: "second-page",
                aml: `<Item type="RefSecurityRecord" action="get" select="item_number" orderBy="item_number" pagesize="2" page="2">
                    <item_number condition="like">TEAM-%</item_number>
                </Item>`,
            },
        ],

        check(observation) {
            equalContract(
                stepAt(observation, 0).response.items.map((item) => item.properties.item_number),
                ["TEAM-02", "TEAM-03"],
                "Team permissions filter before paging.",
            );
            equalContract(
                stepAt(observation, 1).response.items.map((item) => item.properties.item_number),
                ["TEAM-04", "TEAM-05"],
                "Default and custom Team roles participate in the same query.",
            );
            equalContract(
                stepAt(observation, 0).response.messages?.find(
                    (message) => message.name === "itemmax",
                )?.value,
                "5",
                "Paging counts include only permitted records.",
            );
            unchanged(observation);
        },
    },
    {
        id: "team-membership-change",
        capabilities: [CapabilityId.NativePermissions, CapabilityId.Relationships],
        steps: [
            {
                name: "membership",
                aml: `<Item type="Team Identity" action="get" select="id,team_role">
                    <source_id><Item type="Team" action="get"><name>Reference Alpha</name></Item></source_id>
                    <team_role>60EBF9D1BB584921A73FA2F8D74DAF80</team_role>
                </Item>`,
            },
            {
                name: "changed",
                aml: '<Item type="Team Identity" action="edit" id="{{membership}}"><team_role>65ABF0DF1F764001A2A91934910ED93D</team_role></Item>',
            },
            {
                name: "manager-denied",
                aml: '<Item type="RefSecurityRecord" action="get"><item_number>TEAM-02</item_number></Item>',
            },
            {
                name: "source-denied",
                aml: '<Item type="RefSecurityLink" action="get"><label>Protected related record</label></Item>',
            },
            {
                name: "whole-team",
                aml: '<Item type="RefSecurityRecord" action="get"><item_number>TEAM-07</item_number></Item>',
            },
        ],

        check(observation) {
            equalContract(
                valueAt(observation, 1, "team_role"),
                "65ABF0DF1F764001A2A91934910ED93D",
                "The membership stores the selected role.",
            );
            equalContract(
                stepAt(observation, 2).response.items.length,
                0,
                "Manager rights disappear on the next request.",
            );
            equalContract(
                stepAt(observation, 3).response.items.length,
                0,
                "Source-inherited access sees the same membership change.",
            );
            equalContract(
                valueAt(observation, 4, "item_number"),
                "TEAM-07",
                "The Team wildcard still includes the new Guest role.",
            );
            const membership = stepAt(observation, 4).state.find(
                (item) =>
                    item.type === "Team Identity" &&
                    item.properties.source_id === "B7200000000000000000000000000001",
            );
            equalContract(
                membership?.properties.team_role,
                valueAt(observation, 1, "team_role"),
                "Raw state retains the committed membership change.",
            );
        },
    },
    {
        id: "team-role-promotion",
        capabilities: [CapabilityId.NativePermissions, CapabilityId.Lifecycles],
        steps: [
            {
                name: "approved",
                aml: '<Item type="RefSecurityRecord" action="promoteItem" id="{{team-promote}}"><state>Approved</state></Item>',
            },
            {
                name: "denied",
                aml: '<Item type="RefSecurityRecord" action="promoteItem" id="{{team-reject}}"><state>Approved</state></Item>',
            },
        ],

        check(observation) {
            equalContract(
                valueAt(observation, 0, "state"),
                "Approved",
                "The actor can promote the Team they manage.",
            );
            equalContract(
                stepAt(observation, 1).response.error?.code,
                "PermissionDenied",
                "Update rights cannot substitute for another Team's transition role.",
            );
            equalContract(
                stepAt(observation, 1).outcome,
                ExecutionOutcome.RolledBack,
                "The rejected promotion rolls back.",
            );
            equalContract(
                stepAt(observation, 1).state,
                stepAt(observation, 0).state,
                "Only the previously approved Item remains changed.",
            );
        },
    },
];
