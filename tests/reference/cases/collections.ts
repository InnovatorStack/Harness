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
                "A single add has a one-item collection.",
            );
            equalContract(
                step.events[0]?.context.items[0]?.attributes.id,
                resultId(observation, 0),
                "The collection contains the persisted new identity.",
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
                    "RefBatchAfterVersion",
                    "RefBatchBeforeUpdate",
                    "RefBatchAfterUpdate",
                    "RefBatchBeforeUpdate",
                    "RefBatchAfterUpdate",
                    "RefBatchUpdateCollection",
                ],
                "Collection phases enclose the individual update phases.",
            );
            const version = step.events[0]?.context.items;
            requireContract(version?.length === 2, "After-version receives both generations.");
            requireContract(
                version.every(
                    (item) =>
                        item.properties.generation === "2" && item.properties.name === "Original",
                ),
                "Version contexts precede the updates.",
            );
            const updates = step.events.at(-1)?.context.items;
            requireContract(updates?.length === 2, "After-update receives both updated records.");
            requireContract(
                updates.every(
                    (item) =>
                        item.properties.name === "Changed" && Boolean(item.properties.locked_by_id),
                ),
                "Collection hooks run before edit unlock.",
            );
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
        id: "versionable-relationship-copy-contexts",
        capabilities: [CapabilityId.RelationshipVersioning, CapabilityId.CollectionEvents],
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
            const before = step.events.find((event) => event.method === "RefBatchBeforeCopy");
            const after = step.events.find((event) => event.method === "RefBatchAfterCopy");
            requireContract(
                before?.context.items.length === 2 && after?.context.items.length === 2,
                "Copy hooks receive the complete relationship collection.",
            );
            const sourceIds = new Set(before.context.items.map((item) => item.attributes.id));

            for (const item of after.context.items) {
                requireContract(!sourceIds.has(item.attributes.id), "Copies have new identities.");
                equalContract(
                    item.properties.config_id,
                    item.attributes.id,
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
