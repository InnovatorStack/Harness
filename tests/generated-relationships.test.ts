import { expect, test } from "bun:test";

import { createHarness } from "../src/index.js";
import { parseItems } from "../src/items/xml.js";
import { generatedUpdateSources } from "./helpers/generated-updates.js";
import { referenceProject } from "./helpers/references.js";

const schema = `<Item type="ItemType" action="edit" id="ReferenceFixed"><Relationships>
    <Item type="Property" action="add"><name>name</name><data_type>string</data_type></Item>
</Relationships></Item>
<Item type="ItemType" action="add" id="NESTED_REFERENCE">
    <name>NestedReference</name><is_relationship>1</is_relationship><Relationships>
        <Item type="Property" action="add"><name>name</name><data_type>string</data_type></Item>
    </Relationships>
</Item>
<Item type="RelationshipType" action="add"><name>NestedReference</name>
    <relationship_id>NESTED_REFERENCE</relationship_id><source_id>ReferenceFixed</source_id>
    <related_id>REF_RECORD</related_id><behavior>fixed</behavior>
</Item>`;

const fixtures = `ReferenceFixed: [{ name: "Original link", source_id: { name: "Parent" },
    related_id: { name: "Child" } }],
NestedReference: [{ name: "Nested link", source_id: { name: "Original link" },
    related_id: { name: "Child" } }],`;

test("real generated replacement sees remapped nested relationship IDs before base delegation", async () => {
    await using project = await referenceProject(generatedUpdateSources() + schema, fixtures);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const parent = h.state.getOne("ReferenceRecord", { name: "Parent" });
    const link = h.state.getOne("ReferenceFixed", { name: "Original link" });
    const nested = h.state.getOne("NestedReference", { name: "Nested link" });
    const result = await h.applyAML(
        `<Item type="ReferenceRecord" action="edit" id="${parent.id}"><name>Saved</name>
            <Relationships><Item type="ReferenceFixed" action="update" id="${link.id}">
                <source_id>${parent.id}</source_id><name>Updated link</name><Relationships>
                    <Item type="NestedReference" action="update" id="${nested.id}">
                        <source_id>${link.id}</source_id><name>Updated nested link</name>
                    </Item>
                </Relationships>
            </Item></Relationships>
        </Item>`,
    );
    const copied = h.state.getOne("ReferenceFixed", { source_id: result.getID() });
    const copiedNested = h.state.getOne("NestedReference", { source_id: copied.id });
    const audit = h.state.getOne("ReplacementAudit", { phase: "generated" });
    const request = parseItems(String(audit.properties.request_xml))[0];
    const pendingLink = request?.node.relationships[0];

    expect(result.isError()).toBe(false);
    expect(copied.id).not.toBe(link.id);
    expect(copiedNested.id).not.toBe(nested.id);
    expect(copied.properties.name).toBe("Updated link");
    expect(copiedNested.properties.name).toBe("Updated nested link");
    expect(pendingLink?.attributes.id).toBe(copied.id);
    expect(pendingLink?.properties.source_id).toBe(result.getID());
    expect(pendingLink?.relationships[0]?.attributes.id).toBe(copiedNested.id);
    expect(pendingLink?.relationships[0]?.properties.source_id).toBe(copied.id);
    expect(h.state.getOne("ReferenceFixed", { id: link.id }).properties.name).toBe("Original link");
    expect(h.state.getOne("NestedReference", { id: nested.id }).properties.name).toBe(
        "Nested link",
    );
}, 60_000);
