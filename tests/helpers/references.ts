import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ServerEventVersion } from "../../src/platform/events/types.js";

function link(name: string, behavior: string, target = "REF_RECORD"): string {
    return `<Item type="ItemType" action="add" id="${name}">
        <name>${name}</name><is_relationship>1</is_relationship>
    </Item><Item type="RelationshipType" action="add"><name>${name}</name>
        <relationship_id>${name}</relationship_id><source_id>REF_RECORD</source_id>
        <related_id>${target}</related_id><behavior>${behavior}</behavior>
    </Item>`;
}

const schema = `<AML>
<Item type="ItemType" action="add" id="REF_RECORD"><name>ReferenceRecord</name><is_versionable>1</is_versionable><Relationships>
    <Item type="Property" action="add"><name>name</name><data_type>string</data_type></Item>
    <Item type="Property" action="add"><name>fixed_ref</name><data_type>item</data_type><data_source>REF_RECORD</data_source><item_behavior>fixed</item_behavior></Item>
    <Item type="Property" action="add"><name>float_ref</name><data_type>item</data_type><data_source>REF_RECORD</data_source><item_behavior>float</item_behavior></Item>
</Relationships></Item>
<Item type="ItemType" action="add" id="REF_NOTE"><name>ReferenceNote</name><is_dependent>1</is_dependent><Relationships>
    <Item type="Property" action="add"><name>name</name><data_type>string</data_type></Item>
</Relationships></Item>
<Item type="ItemType" action="add" id="REF_HOLDER"><name>ReferenceHolder</name><Relationships>
    <Item type="Property" action="add"><name>name</name><data_type>string</data_type></Item>
    <Item type="Property" action="add"><name>note</name><data_type>item</data_type><data_source>REF_NOTE</data_source><item_behavior>fixed</item_behavior></Item>
</Relationships></Item>
${link("ReferenceFixed", "fixed")}
${link("ReferenceFloat", "float")}
${link("ReferenceHardFixed", "hard_fixed")}
${link("ReferenceHardFloat", "hard_float")}
${link("ReferenceNotes", "fixed", "REF_NOTE")}
</AML>`;

export async function referenceProject(extra = "", fixtures = "") {
    const cwd = await mkdtemp(join(tmpdir(), "harness-references-"));
    await Bun.write(
        join(cwd, ".harness/packages/source.xml"),
        schema.replace("</AML>", `${extra}</AML>`),
    );
    await Bun.write(
        join(cwd, ".harness/config.ts"),
        `export default {
        csharp: false, session: { user: { login_name: "reference_owner" } },
    };`,
    );
    await Bun.write(
        join(cwd, ".harness/fixtures.ts"),
        `export default {
        User: [{ login_name: "reference_owner", created_on: "2026-01-01T00:00:00", created_by_id: { login_name: "reference_owner" } }],
        ReferenceRecord: [{ name: "Parent" }, { name: "Child" }, { name: "Other parent" }],
        ${fixtures}
    };`,
    );

    return {
        cwd,

        async [Symbol.asyncDispose]() {
            await rm(cwd, { recursive: true, force: true });
        },
    };
}

export function referenceMethod(name: string, code: string): string {
    return `<Item type="Method" action="add" id="REF_${name}">
        <name>${name}</name><method_type>C#</method_type><method_code><![CDATA[${code}]]></method_code>
    </Item>`;
}

export function referenceEvent(
    type: string,
    event: string,
    method: string,
    options: {
        readonly version?: ServerEventVersion;
        readonly order?: number;
        readonly required?: boolean;
    } = {},
): string {
    return `<Item type="Server Event" action="add"><source_id>${type}</source_id>
        <related_id>REF_${method}</related_id><server_event>${event}</server_event>
        <event_version>${options.version ?? ServerEventVersion.Item}</event_version>
        <sort_order>${options.order ?? 0}</sort_order><is_required>${options.required ? 1 : 0}</is_required>
    </Item>`;
}

export const referenceLifecycle = `<Item type="Life Cycle Map" action="add" id="REF_LIFECYCLE">
    <name>Reference lifecycle</name><start_state>REF_STATE_FIXED</start_state><Relationships>
        <Item type="Life Cycle State" action="add" id="REF_STATE_FIXED"><name>Fixed</name><item_behavior>fixed</item_behavior></Item>
        <Item type="Life Cycle State" action="add" id="REF_STATE_FLOAT"><name>Floating</name><item_behavior>float</item_behavior></Item>
        <Item type="Life Cycle State" action="add" id="REF_STATE_HARD"><name>Frozen</name><item_behavior>hard_fixed</item_behavior></Item>
        <Item type="Life Cycle Transition" action="add"><from_state>REF_STATE_FIXED</from_state><to_state>REF_STATE_FLOAT</to_state></Item>
        <Item type="Life Cycle Transition" action="add"><from_state>REF_STATE_FLOAT</from_state><to_state>REF_STATE_HARD</to_state></Item>
        <Item type="Life Cycle Transition" action="add"><from_state>REF_STATE_HARD</from_state><to_state>REF_STATE_FLOAT</to_state></Item>
    </Relationships>
</Item><Item type="ItemType Life Cycle" action="add"><source_id>REF_RECORD</source_id><related_id>REF_LIFECYCLE</related_id></Item>`;
