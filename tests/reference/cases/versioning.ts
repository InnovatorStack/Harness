import { CapabilityId } from "../../../src/index.js";
import { equalContract, requireContract, resultId, stepAt, valueAt } from "../contracts.js";
import type { ReferenceCase } from "../types.js";

export const versioningCases: readonly ReferenceCase[] = [
    {
        id: "first-and-subsequent-saves",
        capabilities: [CapabilityId.Generations, CapabilityId.Locks, CapabilityId.Relationships],
        steps: [
            { name: "lock", aml: '<Item type="RefDocument" action="lock" id="{{document}}" />' },
            {
                name: "first-save",
                aml: '<Item type="RefDocument" action="update" id="{{document}}"><name>First save</name></Item>',
            },
            {
                name: "second-save",
                aml: '<Item type="RefDocument" action="update" id="{{first-save}}"><name>Second save</name></Item>',
            },
            {
                name: "unlock",
                aml: '<Item type="RefDocument" action="unlock" id="{{second-save}}" />',
            },
        ],

        check(observation) {
            const flags = ["0", "1", "1", "0"];

            for (let index = 0; index < flags.length; index += 1) {
                equalContract(
                    valueAt(observation, index, "new_version"),
                    flags[index],
                    "The native saved-generation marker follows the lock cycle.",
                );
            }

            requireContract(
                resultId(observation, 1) !== resultId(observation, 0),
                "First save must create an ID.",
            );
            equalContract(
                resultId(observation, 2),
                resultId(observation, 1),
                "A second save reuses the generation.",
            );
            equalContract(
                valueAt(observation, 2, "generation"),
                "2",
                "Only one generation is created.",
            );
            equalContract(
                valueAt(observation, 2, "config_id"),
                resultId(observation, 0),
                "Configuration identity stays fixed.",
            );
            equalContract(
                stepAt(observation, 2).state.filter((record) => record.type === "RefLink").length,
                2,
                "Owned relationships must be copied with the new generation.",
            );
        },
    },
    {
        id: "version-suppression",
        capabilities: [CapabilityId.Generations],
        steps: [
            {
                name: "edit",
                aml: '<Item type="RefDocument" action="edit" version="0" id="{{document}}"><name>Suppressed</name></Item>',
            },
        ],

        check(observation) {
            equalContract(
                valueAt(observation, 0, "generation"),
                "1",
                "version=0 retains generation.",
            );
            equalContract(
                stepAt(observation, 0).state.length,
                observation.initial.length,
                "No rows are cloned.",
            );
        },
    },
    {
        id: "manual-versioning",
        capabilities: [CapabilityId.Generations],
        steps: [
            {
                name: "edit",
                aml: '<Item type="RefManual" action="edit" id="{{manual}}"><name>Manual save</name></Item>',
            },
            { name: "version", aml: '<Item type="RefManual" action="version" id="{{manual}}" />' },
        ],

        check(observation) {
            equalContract(
                valueAt(observation, 0, "generation"),
                "1",
                "Manual edit does not version.",
            );
            equalContract(
                valueAt(observation, 1, "generation"),
                "2",
                "Explicit version creates a generation.",
            );
            requireContract(
                resultId(observation, 0) !== resultId(observation, 1),
                "Explicit version creates an ID.",
            );
        },
    },
    {
        id: "current-and-history-queries",
        capabilities: [CapabilityId.Generations, CapabilityId.Queries],
        steps: [
            {
                name: "edit",
                aml: '<Item type="RefDocument" action="edit" id="{{document}}"><name>Current</name></Item>',
            },
            {
                name: "current",
                aml: '<Item type="RefDocument" action="get"><config_id>{{document}}</config_id></Item>',
            },
            {
                name: "history",
                aml: '<Item type="RefDocument" action="get"><config_id>{{document}}</config_id><is_current>0</is_current></Item>',
            },
        ],

        check(observation) {
            equalContract(
                resultId(observation, 1),
                resultId(observation, 0),
                "Normal queries select current generation.",
            );
            requireContract(
                resultId(observation, 2) !== resultId(observation, 1),
                "History must select the old ID.",
            );
            equalContract(
                valueAt(observation, 2, "name"),
                "Original",
                "Historical values remain intact.",
            );
        },
    },
];
