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

const capabilities = [CapabilityId.Generations, CapabilityId.ServerEvents, CapabilityId.CSharp];

export const generatedUpdateCases: readonly ReferenceCase[] = [
    {
        id: "base-delegation-updates-live-input",
        capabilities,
        steps: [
            {
                name: "lock",
                aml: '<Item type="RefStateRecord" action="lock" id="{{state-record}}" />',
            },
            {
                name: "save",
                aml: '<Item type="RefStateRecord" action="update" id="{{state-record}}"><name>Verify live input</name></Item>',
            },
        ],

        check(observation) {
            equalContract(
                valueAt(observation, 1, "note"),
                "Live input verified",
                "Both replacements verified the base-mutated input and retained XML nodes.",
            );
            equalContract(valueAt(observation, 1, "generation"), "2", "One generation is saved.");
            equalContract(
                valueAt(observation, 1, "name"),
                "Verify live input",
                "Native request synchronization retains pending business values.",
            );
            equalContract(
                stepAt(observation, 1).outcome,
                ExecutionOutcome.Committed,
                "Successful input observations share the base action's transaction.",
            );
        },
    },
    {
        id: "generated-replacement-base-delegation",
        capabilities,
        steps: [
            {
                name: "lock",
                aml: '<Item type="RefStateRecord" action="lock" id="{{state-record}}" />',
            },
            {
                name: "save",
                aml: '<Item type="RefStateRecord" action="update" id="{{state-record}}"><name>Change generated</name></Item>',
            },
        ],

        check(observation) {
            const step = stepAt(observation, 1);
            const updates = step.events.filter((event) => event.event === "onUpdate");
            equalContract(updates.length, 2, "Original and generated updates enter replacement.");
            equalContract(
                updates[1]?.context.items[0]?.attributes.action,
                "version",
                "The generated action retains its version context.",
            );
            equalContract(
                updates[1]?.context.items[0]?.attributes.oldId,
                valueAt(observation, 1, "config_id"),
                "The generated replacement receives the original ID.",
            );
            equalContract(
                valueAt(observation, 1, "name"),
                "Changed by generated replacement",
                "The delegated base saves replacement changes.",
            );
            equalContract(
                valueAt(observation, 1, "note"),
                "Generated response",
                "Response changes survive the original base delegation.",
            );
            equalContract(valueAt(observation, 1, "generation"), "2", "Only one clone is created.");
            requireContract(
                Boolean(valueAt(observation, 1, "locked_by_id")),
                "Update retains its lock.",
            );
            const stored = step.state.find((record) => record.id === resultId(observation, 1));
            requireContract(
                stored?.properties.note !== "Generated response",
                "Response stays transient.",
            );
        },
    },
    {
        id: "generated-replacement-skips-base",
        capabilities,
        steps: [
            {
                name: "replace",
                aml: '<Item type="RefStateRecord" action="version" id="{{state-record}}"><name>Skip generated</name></Item>',
            },
        ],

        check(observation) {
            const step = stepAt(observation, 0);
            equalContract(
                step.response.result,
                "Generated update replaced",
                "The replacement owns the result.",
            );
            equalContract(step.outcome, ExecutionOutcome.Committed, "Versioning still commits.");
            const generated = step.state.filter(
                (record) =>
                    record.type === "RefStateRecord" && record.properties.generation === "2",
            );
            equalContract(generated.length, 1, "The earlier version phase created one clone.");
            equalContract(
                generated[0]?.properties.name,
                "Original",
                "Pending data was not written.",
            );
            requireContract(
                Boolean(generated[0]?.properties.locked_by_id),
                "The skipped base did not unlock.",
            );
        },
    },
    {
        id: "generated-replacement-after-base-rollback",
        capabilities,
        steps: [
            {
                name: "reject",
                aml: '<Item type="RefStateRecord" action="edit" id="{{state-record}}"><name>Reject generated replacement</name></Item>',
            },
        ],

        check(observation) {
            const step = stepAt(observation, 0);
            equalContract(
                step.outcome,
                ExecutionOutcome.RolledBack,
                "The base update shares rollback.",
            );
            requireContract(
                step.response.error?.message.includes(
                    "Reference generated replacement rejected",
                ) === true,
                "The replacement failure reaches the caller.",
            );
            unchanged(observation);
        },
    },
    ...["edit", "version"].map((action): ReferenceCase => ({
        id: `generated-replacement-${action}-where`,
        capabilities,
        steps: [
            {
                name: "save",
                aml: `<Item type="RefStateRecord" action="${action}" where="item_number = 'STATE-001'"><name>Saved</name></Item>`,
            },
        ],

        check(observation) {
            const updates = stepAt(observation, 0).events.filter(
                (event) => event.event === "onUpdate",
            );
            equalContract(
                updates.length,
                action === "version" ? 1 : 2,
                "Explicit version enters update only for its clone; automatic saves enter twice.",
            );
            const generated = updates.at(-1)?.context.items[0];
            equalContract(
                generated?.attributes.oldId,
                action === "version"
                    ? " ( item_number = 'STATE-001' ) /*WhereClauseHelper marker*/ "
                    : valueAt(observation, 0, "config_id"),
                "Explicit version preserves WHERE; automatic version uses selected IDs.",
            );
            equalContract(
                generated?.attributes[action === "version" ? "idlist" : "id"],
                resultId(observation, 0),
                "The generated selector follows the native criteria kind.",
            );
        },
    })),
];
