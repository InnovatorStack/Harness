import { CapabilityId } from "../../../src/index.js";
import {
    equalContract,
    requireContract,
    resultId,
    stepAt,
    unchanged,
    valueAt,
} from "../contracts.js";
import type { ReferenceCase } from "../types.js";

export const referenceCases: readonly ReferenceCase[] = [
    {
        id: "fixed-and-floating-item-properties",
        capabilities: [CapabilityId.Generations, CapabilityId.FloatingReferences],
        steps: [
            {
                name: "child",
                aml: '<Item type="RefDocument" action="add"><item_number>CHILD-001</item_number><name>Child</name></Item>',
            },
            {
                name: "owner",
                aml: '<Item type="RefDocument" action="edit" id="{{document}}"><fixed_ref>{{child}}</fixed_ref><float_ref>{{child}}</float_ref></Item>',
            },
            {
                name: "version-child",
                aml: '<Item type="RefDocument" action="edit" id="{{child}}"><name>Child after edit</name></Item>',
            },
            { name: "read-owner", aml: '<Item type="RefDocument" action="get" id="{{owner}}" />' },
        ],

        check(observation) {
            equalContract(
                valueAt(observation, 3, "fixed_ref"),
                resultId(observation, 0),
                "The fixed property retains the original target generation.",
            );
            equalContract(
                valueAt(observation, 3, "float_ref"),
                resultId(observation, 2),
                "The floating property follows the new current generation.",
            );
        },
    },
    {
        id: "historical-relationship-freeze",
        capabilities: [
            CapabilityId.Generations,
            CapabilityId.FloatingReferences,
            CapabilityId.Relationships,
        ],
        steps: [
            {
                name: "child",
                aml: '<Item type="RefDocument" action="add"><item_number>CHILD-002</item_number><name>Child</name></Item>',
            },
            {
                name: "link",
                aml: '<Item type="RefLink" action="add"><source_id>{{document}}</source_id><related_id>{{child}}</related_id><label>Floating link</label><behavior>float</behavior></Item>',
            },
            {
                name: "parent-version",
                aml: '<Item type="RefDocument" action="edit" id="{{document}}"><name>New parent generation</name></Item>',
            },
            {
                name: "child-version",
                aml: '<Item type="RefDocument" action="edit" id="{{child}}"><name>New child generation</name></Item>',
            },
        ],

        check(observation) {
            const links = stepAt(observation, 3).state.filter(
                (record) =>
                    record.type === "RefLink" && record.properties.label === "Floating link",
            );
            const old = links.find((record) => record.id === resultId(observation, 1));
            const current = links.find(
                (record) => record.properties.source_id === resultId(observation, 2),
            );
            requireContract(
                old !== undefined && current !== undefined,
                "Both relationship configurations survive.",
            );
            equalContract(
                old.properties.related_id,
                resultId(observation, 0),
                "Historical targets stay fixed.",
            );
            equalContract(
                old.properties.behavior,
                "hard_fixed",
                "Historical relationships are frozen.",
            );
            equalContract(
                current.properties.related_id,
                resultId(observation, 3),
                "Current relationships float.",
            );
        },
    },
    {
        id: "dependent-item-cascade",
        capabilities: [CapabilityId.ItemActions, CapabilityId.Relationships],
        steps: [
            {
                name: "owner",
                aml: '<Item type="RefPlain" action="add"><item_number>DEPENDENT-OWNER</item_number><owned_ref><Item type="RefDependent" action="add"><item_number>DEPENDENT-001</item_number></Item></owned_ref></Item>',
            },
            {
                name: "delete-owner",
                aml: '<Item type="RefPlain" action="delete" id="{{owner}}" />',
            },
        ],

        check(observation) {
            equalContract(
                stepAt(observation, 0).state.filter((record) => record.type === "RefDependent")
                    .length,
                1,
                "The nested dependent is persisted with its owner.",
            );
            unchanged(observation);
        },
    },
];
