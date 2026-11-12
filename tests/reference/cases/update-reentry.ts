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

export const updateReentryCases: readonly ReferenceCase[] = [
    {
        id: "hook-suppresses-generation",
        capabilities: [CapabilityId.Generations, CapabilityId.ServerEvents],
        steps: [
            {
                name: "save",
                aml: '<Item type="RefDocument" action="edit" id="{{document}}"><name>Suppress in hook</name></Item>',
            },
        ],

        check(observation) {
            equalContract(
                valueAt(observation, 0, "generation"),
                "1",
                "The hook suppresses versioning.",
            );
            equalContract(
                valueAt(observation, 0, "config_id"),
                resultId(observation, 0),
                "The original ID remains.",
            );
            equalContract(
                valueAt(observation, 0, "note"),
                "Suppressed by source",
                "Hook changes persist.",
            );
            const events = stepAt(observation, 0).events;
            equalContract(
                events.filter((event) => event.event === "onBeforeUpdate").length,
                1,
                "Only one update pass runs.",
            );
            equalContract(
                events.filter((event) => event.event === "onBeforeVersion").length,
                0,
                "Version hooks do not run.",
            );
        },
    },
    {
        id: "automatic-update-reentry",
        capabilities: [CapabilityId.Generations, CapabilityId.ServerEvents],
        steps: [
            {
                name: "save",
                aml: '<Item type="RefDocument" action="edit" id="{{document}}"><name>Temporary preflight</name></Item>',
            },
        ],

        check(observation) {
            const step = stepAt(observation, 0);
            const updates = step.events.filter((event) => event.event === "onBeforeUpdate");
            equalContract(updates.length, 2, "Automatic versioning enters update twice.");
            const initial = updates[0]?.context.items[0];
            const reentry = updates[1]?.context.items[0];
            equalContract(initial?.attributes.action, "edit", "The first pass retains the action.");
            equalContract(reentry?.attributes.action, "version", "Versioning reenters update.");
            equalContract(
                reentry?.attributes.id,
                resultId(observation, 0),
                "Reentry targets the clone.",
            );
            equalContract(
                reentry?.attributes.oldId,
                valueAt(observation, 0, "config_id"),
                "The original ID is retained.",
            );
            requireContract(
                initial?.attributes.id !== reentry?.attributes.id,
                "The generation has a new ID.",
            );
            equalContract(
                reentry?.properties.new_version,
                "1",
                "Reentry carries its version marker.",
            );
            equalContract(
                valueAt(observation, 0, "name"),
                "Temporary preflight",
                "Versioning uses the original pending request.",
            );
        },
    },
    ...["preflight", "reentry"].map((phase): ReferenceCase => ({
        id: `update-${phase}-rejection`,
        capabilities: [CapabilityId.Generations, CapabilityId.ServerEvents],
        steps: [
            {
                name: "reject",
                aml: `<Item type="RefDocument" action="edit" id="{{document}}"><name>Reject ${phase}</name></Item>`,
            },
        ],

        check(observation) {
            const step = stepAt(observation, 0);
            equalContract(
                step.outcome,
                ExecutionOutcome.RolledBack,
                "The source rejection rolls back.",
            );
            requireContract(
                step.response.error?.message.includes(`Reference ${phase} rejected`) === true,
                "The original error reaches the caller.",
            );
            equalContract(
                step.events.filter((event) => event.event === "onBeforeUpdate").length,
                phase === "preflight" ? 1 : 2,
                "Only the expected update passes run.",
            );
            unchanged(observation);
        },
    })),
];
