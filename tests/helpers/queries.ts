import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const schema = `<AML>
<Item type="ItemType" action="add" id="QUERY_PART"><name>QueryPart</name><Relationships>
  <Item type="Property" action="add" id="QUERY_NAME"><name>name</name><data_type>string</data_type></Item>
  <Item type="Property" action="add"><name>note</name><data_type>string</data_type></Item>
  <Item type="Property" action="add"><name>count</name><data_type>integer</data_type></Item>
  <Item type="Property" action="add"><name>price</name><data_type>decimal</data_type></Item>
  <Item type="Property" action="add"><name>due</name><data_type>date</data_type></Item>
  <Item type="Property" action="add" id="QUERY_PARENT"><name>parent</name><data_type>item</data_type><data_source>QUERY_PART</data_source></Item>
  <Item type="Property" action="add"><name>parent_name</name><data_type>foreign</data_type><data_source>QUERY_PARENT</data_source><foreign_property>QUERY_NAME</foreign_property></Item>
</Relationships></Item>
<Item type="ItemType" action="add" id="QUERY_LINK"><name>QueryLink</name><is_relationship>1</is_relationship><Relationships>
  <Item type="Property" action="add"><name>note</name><data_type>string</data_type></Item>
</Relationships></Item>
<Item type="RelationshipType" action="add"><name>QueryLink</name><relationship_id>QUERY_LINK</relationship_id><source_id>QUERY_PART</source_id><related_id>QUERY_PART</related_id></Item>
</AML>`;

export async function queryProject(extra = "") {
    const cwd = await mkdtemp(join(tmpdir(), "harness-queries-"));
    await Bun.write(
        join(cwd, ".harness/packages/source.xml"),
        schema.replace("</AML>", `${extra}</AML>`),
    );
    await Bun.write(join(cwd, ".harness/config.ts"), "export default { csharp: false };");
    await Bun.write(
        join(cwd, ".harness/fixtures.ts"),
        `export default {
    QueryPart: [
        { name: "Alpha", count: 1, note: null, price: "9007199254740992.01", due: "2026-01-01T00:00:00.0000001" },
        { name: "Beta", count: 2, note: "", price: "9007199254740992.02", due: "2026-01-01T00:00:00.0000002", parent: { name: "Alpha" } },
        { name: "O'Neil", count: 3, note: "UPPER", price: "-1.5", due: "2026-01-02T00:00:00Z", parent: { name: "Alpha" } },
        { name: "😀", count: 4, note: "lower", price: "0", due: "2026-01-03T00:00:00Z", parent: { name: "Beta" } },
    ],
    QueryLink: [
        { source_id: { name: "Alpha" }, related_id: { name: "Beta" }, note: "First" },
        { source_id: { name: "Alpha" }, related_id: { name: "O'Neil" }, note: "Second" },
        { source_id: { name: "Beta" }, related_id: { name: "😀" }, note: "Other" },
    ],
};`,
    );

    return {
        cwd,

        async [Symbol.asyncDispose]() {
            await rm(cwd, { recursive: true, force: true });
        },
    };
}

export function queryMethod(name: string, code: string): string {
    return `<Item type="Method" action="add" id="QUERY_${name}">
        <name>${name}</name><method_type>C#</method_type><method_code><![CDATA[${code}]]></method_code>
    </Item>`;
}
