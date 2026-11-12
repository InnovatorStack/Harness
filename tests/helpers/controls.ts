import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entrypoint = Bun.fileURLToPath(new URL("../../src/index.ts", import.meta.url));
const schema = `<AML>
<Item type="ItemType" action="add" id="CONTROL_DOCUMENT">
  <name>ControlledDocument</name><is_versionable>1</is_versionable><Relationships>
    <Item type="Property" action="add"><name>item_number</name><data_type>string</data_type><is_required>1</is_required></Item>
    <Item type="Property" action="add"><name>description</name><data_type>string</data_type></Item>
    <Item type="Property" action="add"><name>created_on</name><data_type>date</data_type><is_required>1</is_required></Item>
  </Relationships>
</Item>
<Item type="ItemType" action="add" id="CONTROL_LINK"><name>ControlledLink</name><is_relationship>1</is_relationship></Item>
<Item type="RelationshipType" action="add"><name>ControlledLink</name><relationship_id>CONTROL_LINK</relationship_id><source_id>CONTROL_DOCUMENT</source_id><related_id>CONTROL_DOCUMENT</related_id></Item>
<Item type="ItemType" action="add" id="CONTROL_AUDIT"><name>ControlAudit</name><Relationships>
  <Item type="Property" action="add"><name>name</name><data_type>string</data_type></Item>
  <Item type="Property" action="add"><name>created_on</name><data_type>date</data_type><is_required>1</is_required></Item>
</Relationships></Item>
</AML>`;

export async function controlProject(extra = "") {
    const cwd = await mkdtemp(join(tmpdir(), "harness-controls-"));
    await Bun.write(
        join(cwd, ".harness/packages/source.xml"),
        schema.replace("</AML>", `${extra}</AML>`),
    );
    await Bun.write(
        join(cwd, ".harness/config.ts"),
        `
import { fixedClock, seededIds } from ${JSON.stringify(entrypoint)};
export default {
    clock: fixedClock("2026-01-01T09:00:00Z"),
    ids: seededIds("control-tests"),
    csharp: false,
    session: { user: { login_name: "owner" } },
};`,
    );
    await Bun.write(
        join(cwd, ".harness/fixtures.ts"),
        `export default {
    User: [{ login_name: "owner", created_on: "2025-01-01T00:00:00", created_by_id: { login_name: "owner" } }],
    ControlledDocument: [
        { item_number: "DOC-001", description: "Original", created_on: "2025-01-01T00:00:00" },
        { item_number: "DOC-002", description: "Related", created_on: "2025-01-01T00:00:00" },
    ],
    ControlledLink: [{ source_id: { item_number: "DOC-001" }, related_id: { item_number: "DOC-002" } }],
};`,
    );

    return {
        cwd,

        async [Symbol.asyncDispose]() {
            await rm(cwd, { recursive: true, force: true });
        },
    };
}

export function controlMethod(name: string, code: string): string {
    return `<Item type="Method" action="add" id="CONTROL_${name}">
        <name>${name}</name><method_type>C#</method_type><method_code><![CDATA[${code}]]></method_code>
    </Item>`;
}
