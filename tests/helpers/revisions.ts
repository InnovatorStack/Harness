import { referenceProject } from "./references.js";

export const revisionSchema = `
<Item type="Revision" action="add" id="REVISION_SEQUENCE"><name>Document revisions</name><revision>A C G</revision></Item>
<Item type="ItemType" action="add" id="REVISION_DOCUMENT"><name>RevisionDocument</name><is_versionable>1</is_versionable><revisions>REVISION_SEQUENCE</revisions><Relationships>
    <Item type="Property" action="add"><name>name</name><data_type>string</data_type></Item>
    <Item type="Property" action="add"><name>locked_by_id</name><data_type>item</data_type><data_source>45E899CD2859442982EB22BB2DF683E5</data_source></Item>
    <Item type="Property" action="add"><name>fixed_ref</name><data_type>item</data_type><data_source>REVISION_DOCUMENT</data_source><item_behavior>fixed</item_behavior></Item>
    <Item type="Property" action="add"><name>float_ref</name><data_type>item</data_type><data_source>REVISION_DOCUMENT</data_source><item_behavior>float</item_behavior></Item>
</Relationships></Item>
<Item type="ItemType" action="add" id="REVISION_LINK"><name>RevisionLink</name><is_relationship>1</is_relationship></Item>
<Item type="RelationshipType" action="add"><name>RevisionLink</name><relationship_id>REVISION_LINK</relationship_id><source_id>REVISION_DOCUMENT</source_id><related_id>REVISION_DOCUMENT</related_id><behavior>float</behavior></Item>
<Item type="ItemType" action="add" id="REVISION_HARD_LINK"><name>RevisionHardLink</name><is_relationship>1</is_relationship></Item>
<Item type="RelationshipType" action="add"><name>RevisionHardLink</name><relationship_id>REVISION_HARD_LINK</relationship_id><source_id>REVISION_DOCUMENT</source_id><related_id>REVISION_DOCUMENT</related_id><behavior>hard_fixed</behavior></Item>
<Item type="Life Cycle Map" action="add" id="REVISION_LIFECYCLE"><name>Revision lifecycle</name><start_state>REVISION_DRAFT</start_state><Relationships>
    <Item type="Life Cycle State" action="add" id="REVISION_DRAFT"><name>Draft</name><item_behavior>float</item_behavior><state_permission_id type="Permission">9122CD065CF04141B8EFE263FC80BEA4</state_permission_id></Item>
    <Item type="Life Cycle State" action="add" id="REVISION_RELEASED"><name>Released</name><set_is_released>1</set_is_released><set_not_lockable>1</set_not_lockable><item_behavior>hard_fixed</item_behavior></Item>
    <Item type="Life Cycle Transition" action="add"><from_state>REVISION_DRAFT</from_state><to_state>REVISION_RELEASED</to_state></Item>
</Relationships></Item>
<Item type="ItemType Life Cycle" action="add"><source_id>REVISION_DOCUMENT</source_id><related_id>REVISION_LIFECYCLE</related_id></Item>`;

export const revisionFixtures = `RevisionDocument: [
    { name: "Released document", state: "Released", major_rev: "A", release_date: "2026-01-02T00:00:00", effective_date: "2026-01-03T00:00:00", superseded_date: "2026-01-04T00:00:00" },
    { name: "Draft document", state: "Draft" },
]`;

export function revisionProject(extra = "", fixtures = revisionFixtures) {
    return referenceProject(revisionSchema + extra, fixtures);
}
