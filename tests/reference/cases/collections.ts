import { CapabilityId, ExecutionOutcome } from "../../../src/index.js";
import { equalContract, requireContract, resultId, stepAt, unchanged } from "../contracts.js";
import type { ReferenceCase } from "../types.js";

export const collectionCases: readonly ReferenceCase[] = [
    {
        id: "collection-after-add",
        capabilities: [CapabilityId.CollectionEvents],
        steps: [
            {
                name: "add",
                aml: '<Item type="RefBatch" action="add"><item_number>BATCH-003</item_number><name>Created</name></Item>',
            },
        ],

        check(observation) {
            const step = stepAt(observation, 0);
            equalContract(
                step.events.map((event) => event.method),
                ["RefBatchAfterAdd"],
                "After-add uses the declared collection binding.",
            );
            equalContract(
                step.events[0]?.context.items.length,
                1,
                "A batch hook receives one empty Item.",
            );
            equalContract(
                step.events[0]?.context.items[0]?.type,
                "",
                "The persisted identity is supplied through native event metadata.",
            );
        },
    },
    {
        id: "versioned-collection-update",
        capabilities: [CapabilityId.CollectionEvents, CapabilityId.Generations],
        steps: [
            {
                name: "edit",
                aml: '<Item type="RefBatch" action="edit" idlist="{{batch-first}},{{batch-second}}"><name>Changed</name></Item>',
            },
        ],

        check(observation) {
            const step = stepAt(observation, 0);
            equalContract(
                step.events.map((event) => event.method),
                [
                    "RefBatchBeforeUpdate",
                    "RefBatchAfterVersion",
                    "RefBatchBeforeUpdate",
                    "RefBatchBeforeUpdate",
                    "RefBatchAfterUpdate",
                    "RefBatchAfterUpdate",
                    "RefBatchUpdateCollection",
                ],
                "Collection phases enclose the individual update phases.",
            );
            const version = step.events.find((event) => event.method === "RefBatchAfterVersion")
                ?.context.items;
            equalContract(version?.length, 1, "After-version receives one empty Item.");
            equalContract(version?.[0]?.type, "", "Generated IDs are carried by event metadata.");
            const updates = step.events.at(-1)?.context.items;
            equalContract(updates?.length, 1, "After-update receives one empty Item.");
            equalContract(updates?.[0]?.type, "", "Updates are addressed through event metadata.");
            requireContract(
                step.response.items.every((item) => item.properties.locked_by_id === null),
                "Edit results are unlocked.",
            );
        },
    },
    {
        id: "collection-rejection-rollback",
        capabilities: [CapabilityId.CollectionEvents, CapabilityId.Generations],
        steps: [
            {
                name: "reject",
                aml: '<Item type="RefBatch" action="edit" idlist="{{batch-first}},{{batch-second}}"><name>Reject</name></Item>',
            },
        ],

        check(observation) {
            const step = stepAt(observation, 0);
            equalContract(
                step.outcome,
                ExecutionOutcome.RolledBack,
                "A collection rejection rolls back the entire action.",
            );
            requireContract(
                step.response.error?.message.includes("Reference collection rejected") === true,
                "The source rejection reaches the caller.",
            );
            unchanged(observation);
        },
    },
    {
        id: "parent-version-suppresses-copy-hooks",
        capabilities: [CapabilityId.RelationshipVersioning, CapabilityId.ServerEvents],
        steps: [
            {
                name: "first-link",
                aml: '<Item type="RefBatchLink" action="add"><source_id>{{batch-first}}</source_id><related_id>{{batch-second}}</related_id><label>First</label></Item>',
            },
            {
                name: "second-link",
                aml: '<Item type="RefBatchLink" action="add"><source_id>{{batch-first}}</source_id><related_id>{{batch-second}}</related_id><label>Second</label></Item>',
            },
            {
                name: "parent",
                aml: '<Item type="RefBatch" action="edit" id="{{batch-first}}"><name>Changed</name></Item>',
            },
        ],

        check(observation) {
            const step = stepAt(observation, 2);
            equalContract(
                step.events.filter((event) =>
                    ["onBeforeCopy", "onAfterCopy"].includes(event.event),
                ),
                [],
                "Parent versioning does not execute business copy hooks.",
            );
            const sourceIds = new Set([resultId(observation, 0), resultId(observation, 1)]);
            const copied = step.state.filter(
                (record) =>
                    record.type === "RefBatchLink" &&
                    record.properties.source_id === resultId(observation, 2),
            );
            equalContract(copied.length, 2, "Both stored relationships are cloned.");

            for (const item of copied) {
                requireContract(!sourceIds.has(item.id), "Copies have new identities.");
                equalContract(
                    item.properties.config_id,
                    item.id,
                    "Cloned relationships start fresh configurations.",
                );
                equalContract(item.properties.generation, "1", "A clone starts at generation one.");
                equalContract(
                    item.properties.source_id,
                    resultId(observation, 2),
                    "Copied relationships belong to the new parent.",
                );
            }

            equalContract(
                step.state.filter((record) => record.type === "RefBatchLink").length,
                4,
                "Original relationships remain alongside their copies.",
            );
        },
    },
];
