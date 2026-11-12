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

export const revisionCases: readonly ReferenceCase[] = [
    {
        id: "released-revision-reset",
        capabilities: [CapabilityId.Revision, CapabilityId.Lifecycles, CapabilityId.Generations],
        steps: [
            {
                name: "revised",
                aml: '<Item type="RefRevision" action="version" id="{{revision}}"><name>Revised</name></Item>',
            },
            {
                name: "historical",
                aml: '<Item type="RefRevision" action="get" id="{{revision}}" />',
            },
        ],

        check(observation) {
            equalContract(
                valueAt(observation, 0, "major_rev"),
                "C",
                "The declared next revision is used.",
            );
            equalContract(
                valueAt(observation, 0, "generation"),
                "2",
                "Generations continue across revisions.",
            );
            equalContract(
                valueAt(observation, 0, "state"),
                "Draft",
                "The lifecycle resets to its start.",
            );
            equalContract(
                valueAt(observation, 0, "is_released"),
                "0",
                "The new cycle clears release status.",
            );
            equalContract(
                valueAt(observation, 0, "release_date"),
                null,
                "The new revision has no release date.",
            );
            equalContract(
                valueAt(observation, 1, "major_rev"),
                "A",
                "Historical revisions remain readable.",
            );
            equalContract(
                valueAt(observation, 1, "state"),
                "Released",
                "The source remains released.",
            );
            equalContract(
                valueAt(observation, 0, "config_id"),
                resultId(observation, 1),
                "The configuration identity is stable.",
            );
            requireContract(
                resultId(observation, 0) !== resultId(observation, 1),
                "A revision creates a new identity.",
            );
            const events = stepAt(observation, 0).events;
            equalContract(
                events.map((event) => event.method),
                ["RefRevisionBefore", "RefRevisionAfter", "RefRevisionUpdated"],
                "Revision hooks retain order.",
            );
            equalContract(
                events[0]?.context.items[0]?.properties.name,
                "Revised",
                "Before-version receives the caller's pending values.",
            );
            equalContract(
                events[1]?.context.items[0]?.properties.state,
                "Draft",
                "After-version sees the reset.",
            );
        },
    },
    {
        id: "released-revision-exhaustion",
        capabilities: [CapabilityId.Revision],
        steps: [
            {
                name: "exhausted",
                aml: '<Item type="RefRevision" action="version" id="{{last-revision}}" />',
            },
        ],

        check(observation) {
            const step = stepAt(observation, 0);
            equalContract(
                step.outcome,
                ExecutionOutcome.RolledBack,
                "Exhaustion cannot persist a generation.",
            );
            requireContract(
                step.response.error?.message.toLowerCase().includes("revision sequence") === true,
                "Sequence exhaustion reaches the caller.",
            );
            unchanged(observation);
        },
    },
    {
        id: "released-revision-rejection",
        capabilities: [CapabilityId.Revision, CapabilityId.ServerEvents],
        steps: [
            {
                name: "reject",
                aml: '<Item type="RefRevision" action="version" id="{{revision}}"><name>Reject</name></Item>',
            },
        ],

        check(observation) {
            const step = stepAt(observation, 0);
            equalContract(
                step.outcome,
                ExecutionOutcome.RolledBack,
                "Hook rejection rolls back the revision.",
            );
            requireContract(
                step.response.error?.message.includes("Reference revision rejected") === true,
                "The original Method rejection reaches the caller.",
            );
            unchanged(observation);
        },
    },
    {
        id: "revision-generations-after-release",
        capabilities: [CapabilityId.Revision, CapabilityId.Generations],
        steps: [
            {
                name: "revised",
                aml: '<Item type="RefRevision" action="version" id="{{revision}}" />',
            },
            { name: "unlock", aml: '<Item type="RefRevision" action="unlock" id="{{revised}}" />' },
            {
                name: "save",
                aml: '<Item type="RefRevision" action="edit" id="{{revised}}"><name>Working change</name></Item>',
            },
        ],

        check(observation) {
            equalContract(
                valueAt(observation, 2, "major_rev"),
                "C",
                "Working generations keep their revision.",
            );
            equalContract(
                valueAt(observation, 2, "generation"),
                "3",
                "The next lock cycle advances the generation.",
            );
            equalContract(
                valueAt(observation, 2, "config_id"),
                valueAt(observation, 0, "config_id"),
                "All generations share the same configuration.",
            );
            requireContract(
                resultId(observation, 2) !== resultId(observation, 0),
                "The new generation has its own identity.",
            );
        },
    },
];
