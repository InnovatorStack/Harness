import { CapabilityId, ExecutionOutcome } from "../../../src/index.js";
import { equalContract, stepAt, unchanged, valueAt } from "../contracts.js";
import type { ReferenceCase } from "../types.js";

export const classificationCases: readonly ReferenceCase[] = [
    {
        id: "class-parent-grants-descendants",
        capabilities: [CapabilityId.NativePermissions, CapabilityId.ItemActions],
        steps: [
            {
                name: "created",
                aml: `<Item type="RefClassified" action="add">
                    <item_number>CLASS-CHILD</item_number>
                    <classification>Technical/Purchased</classification>
                </Item>`,
            },
        ],

        check(observation) {
            equalContract(
                stepAt(observation, 0).outcome,
                ExecutionOutcome.Committed,
                "The ancestor grant applies even with an unchecked descendant row.",
            );
            equalContract(
                valueAt(observation, 0, "classification"),
                "Technical/Purchased",
                "Creation retains the requested class.",
            );
            const record = stepAt(observation, 0).state.find(
                (item) => item.properties.item_number === "CLASS-CHILD",
            );
            equalContract(
                record?.properties.classification,
                "Technical/Purchased",
                "The accepted class is actually stored.",
            );
        },
    },
    {
        id: "class-paths-are-declared-segments",
        capabilities: [CapabilityId.NativePermissions],
        steps: [
            {
                name: "sibling",
                aml: '<Item type="RefClassified" action="add"><item_number>CLASS-SIBLING</item_number><classification>TechnicalExtra</classification></Item>',
            },
            {
                name: "unknown",
                aml: '<Item type="RefClassified" action="add"><item_number>CLASS-UNKNOWN</item_number><classification>Technical/Unknown</classification></Item>',
            },
            {
                name: "case",
                aml: '<Item type="RefClassified" action="add"><item_number>CLASS-CASE</item_number><classification>technical/Purchased</classification></Item>',
            },
            {
                name: "root",
                aml: '<Item type="RefClassified" action="add"><item_number>CLASS-ROOT</item_number></Item>',
            },
        ],

        check(observation) {
            for (const step of observation.steps) {
                const code = ["unknown", "case"].includes(step.name)
                    ? "InvalidClassification"
                    : "PermissionDenied";
                equalContract(
                    step.response.error?.code,
                    code,
                    "The class must be valid and permitted.",
                );
                equalContract(step.outcome, ExecutionOutcome.RolledBack, "The action rolls back.");
                equalContract(step.state, observation.initial, "No rejected Item persists.");
            }

            unchanged(observation);
        },
    },
    {
        id: "class-default-authorizes-creation",
        capabilities: [CapabilityId.NativePermissions, CapabilityId.ItemActions],
        steps: [
            {
                name: "default",
                aml: '<Item type="RefClassDefault" action="add"><item_number>CLASS-DEFAULT</item_number></Item>',
            },
        ],

        check(observation) {
            equalContract(
                stepAt(observation, 0).outcome,
                ExecutionOutcome.Committed,
                "The declared default is authorized through its ancestor grant.",
            );
            equalContract(
                valueAt(observation, 0, "classification"),
                "Technical/Purchased",
                "The default is present in the response.",
            );
            const record = stepAt(observation, 0).state.find(
                (item) => item.properties.item_number === "CLASS-DEFAULT",
            );
            equalContract(
                record?.properties.classification,
                "Technical/Purchased",
                "The database retains the declared default.",
            );
        },
    },
    {
        id: "class-hook-reclassification-rolls-back-batch",
        capabilities: [
            CapabilityId.NativePermissions,
            CapabilityId.ServerEvents,
            CapabilityId.CSharp,
        ],
        steps: [
            {
                name: "reject",
                aml: `<AML>
                    <Item type="RefPlain" action="edit" id="{{plain}}"><name>Must roll back</name></Item>
                    <Item type="RefClassified" action="add">
                        <item_number>CLASS-HOOK</item_number><name>Reclassify</name>
                        <classification>Technical/Purchased</classification>
                    </Item>
                </AML>`,
            },
        ],

        check(observation) {
            equalContract(
                stepAt(observation, 0).response.error?.code,
                "PermissionDenied",
                "The changed class is checked after the original hook executes.",
            );
            equalContract(
                stepAt(observation, 0).outcome,
                ExecutionOutcome.RolledBack,
                "Class denial rolls back the preceding edit and rejected add.",
            );
            unchanged(observation);
        },
    },
    {
        id: "class-scoped-identity-grant",
        capabilities: [CapabilityId.NativePermissions, CapabilityId.CSharp],
        steps: [
            {
                name: "granted",
                aml: '<Item type="RefClassified" action="RefCreateClassWithGrant" />',
            },
            {
                name: "restored",
                aml: '<Item type="RefClassified" action="add"><item_number>CLASS-DENIED</item_number><classification>Commercial</classification></Item>',
            },
        ],

        check(observation) {
            equalContract(
                valueAt(observation, 0, "classification"),
                "Commercial",
                "The scoped identity contributes its class grant.",
            );
            equalContract(
                stepAt(observation, 1).response.error?.code,
                "PermissionDenied",
                "The class grant is gone after the Method completes.",
            );
            equalContract(
                stepAt(observation, 1).state,
                stepAt(observation, 0).state,
                "The denied add preserves the previously committed Item.",
            );
        },
    },
];
