import { CapabilityId } from "../../../src/index.js";
import { equalContract, requireContract, stepAt, unchanged, valueAt } from "../contracts.js";
import type { ReferenceCase } from "../types.js";

export const queryCases: readonly ReferenceCase[] = [
    {
        id: "logical-and-repeated-criteria",
        capabilities: [CapabilityId.Queries],
        steps: [
            {
                name: "query",
                aml: `<Item type="RefPlain" action="get">
                <or><item_number>PLAIN-001</item_number><name>Absent</name></or>
                <name condition="like">Ori%</name><name condition="ne">Absent</name>
            </Item>`,
            },
        ],

        check(observation) {
            equalContract(
                valueAt(observation, 0, "item_number"),
                "PLAIN-001",
                "Grouped and repeated conditions retain their meaning.",
            );
            unchanged(observation);
        },
    },
    {
        id: "query-paging-metadata",
        capabilities: [CapabilityId.Queries],
        steps: [
            {
                name: "page",
                aml: `<Item type="RefDocument" action="get" orderBy="item_number"
                pagesize="1" page="2"><name>Original</name></Item>`,
            },
            {
                name: "empty-page",
                aml: `<Item type="RefDocument" action="get" orderBy="item_number"
                pagesize="1" page="3"><name>Original</name></Item>`,
            },
        ],

        check(observation) {
            equalContract(
                valueAt(observation, 0, "item_number"),
                "LOCKED-001",
                "Paging follows explicit ordering.",
            );
            const metadata = stepAt(observation, 0).response.messages;
            requireContract(
                metadata?.some((entry) => entry.name === "itemmax" && entry.value === "2") === true,
                "Paging retains total item count.",
            );
            equalContract(
                stepAt(observation, 1).response.error?.code,
                "0",
                "An empty page retains the native no-items code.",
            );
            unchanged(observation);
        },
    },
    {
        id: "nested-relationship-hydration",
        capabilities: [CapabilityId.Queries, CapabilityId.Relationships],
        steps: [
            {
                name: "hydrate",
                aml: `<Item type="RefDocument" action="get" id="{{document}}">
                <Relationships><Item type="RefLink" action="get">
                    <label>Owned link</label>
                </Item></Relationships>
            </Item>`,
            },
        ],

        check(observation) {
            const children = stepAt(observation, 0).response.items[0]?.relationships;
            equalContract(children?.length, 1, "The matching relationship is included.");
            equalContract(
                children?.[0]?.properties.label,
                "Owned link",
                "Hydration retains the stored relationship values.",
            );
            unchanged(observation);
        },
    },
];
