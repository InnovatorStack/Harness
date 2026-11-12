export const copyLifecycle = `
<Item type="ItemType" action="edit" id="ReferenceFixed"><Relationships>
    <Item type="Property" action="add"><name>permission_id</name><data_type>item</data_type>
        <data_source>C6A89FDE1294451497801DF78341B473</data_source></Item>
</Relationships></Item>
<Item type="Permission" action="add" id="COPY_DRAFT_PERMISSION"><name>Copy draft</name></Item>
<Item type="Permission" action="add" id="COPY_WORKING_PERMISSION"><name>Copy working</name></Item>
<Item type="Life Cycle Map" action="add" id="COPY_CYCLE">
    <name>Copy lifecycle</name><start_state>COPY_DRAFT</start_state><Relationships>
        <Item type="Life Cycle State" action="add" id="COPY_DRAFT">
            <name>Draft</name><item_behavior>hard_float</item_behavior>
            <state_permission_id>COPY_DRAFT_PERMISSION</state_permission_id>
        </Item>
        <Item type="Life Cycle State" action="add" id="COPY_WORKING">
            <name>Working</name><set_not_lockable>1</set_not_lockable>
            <state_permission_id>COPY_WORKING_PERMISSION</state_permission_id>
        </Item>
    </Relationships>
</Item>
<Item type="ItemType Life Cycle" action="add">
    <source_id>ReferenceFixed</source_id><related_id>COPY_CYCLE</related_id>
</Item>`;

export const copyFixtures = `ReferenceFixed: [{ source_id: { name: "Parent" },
    related_id: { name: "Child" }, sort_order: 7, state: "Working" }],`;

export const classifiedCopy = `
<Item type="ItemType" action="edit" id="ReferenceFixed">
    <class_structure><![CDATA[<class><class name="Special"><class name="Detail" /></class></class>]]></class_structure>
</Item>
<Item type="Life Cycle Map" action="add" id="COPY_SPECIAL_CYCLE">
    <name>Special copy lifecycle</name><start_state>COPY_SPECIAL_DRAFT</start_state><Relationships>
        <Item type="Life Cycle State" action="add" id="COPY_SPECIAL_DRAFT">
            <name>Prototype</name><state_permission_id>COPY_DRAFT_PERMISSION</state_permission_id>
        </Item>
        <Item type="Life Cycle State" action="add" id="COPY_SPECIAL_WORKING">
            <name>Working</name><set_not_lockable>1</set_not_lockable>
            <state_permission_id>COPY_WORKING_PERMISSION</state_permission_id>
        </Item>
    </Relationships>
</Item>
<Item type="ItemType Life Cycle" action="add">
    <source_id>ReferenceFixed</source_id><related_id>COPY_SPECIAL_CYCLE</related_id>
    <class_path>Special</class_path>
</Item>`;

export const copyDetails = `
<Item type="ItemType" action="add" id="COPY_DETAIL">
    <name>CopyDetail</name><is_relationship>1</is_relationship><use_src_access>1</use_src_access>
    <Relationships><Item type="Property" action="add">
        <name>value</name><data_type>string</data_type>
    </Item></Relationships>
</Item>
<Item type="RelationshipType" action="add"><name>CopyDetail</name>
    <relationship_id>COPY_DETAIL</relationship_id><source_id>ReferenceFixed</source_id>
    <related_id>REF_RECORD</related_id><behavior>fixed</behavior>
</Item>`;

export const copyDetailFixtures = `${copyFixtures}
    CopyDetail: [{ source_id: { sort_order: 7 }, related_id: { name: "Child" }, value: "Nested" }],`;

export const checkCopiedLifecycleSource = `
    var links = this.newItem("ReferenceFixed", "get");
    links.setProperty("source_id", eventData.NewItemId);
    var copied = links.apply();
    if (copied.isError()) { return copied; }
    if (copied.getItemCount() != 1 || copied.getProperty("state") != "Draft") {
        throw new Exception("Copied lifecycle was not initialized before after-version");
    }
    if (copied.getProperty("permission_id") != "COPY_DRAFT_PERMISSION") {
        throw new Exception("Copied lifecycle permission was not applied");
    }
    var details = this.newItem("CopyDetail", "get");
    details.setProperty("source_id", copied.getID());
    var nested = details.apply();
    if (nested.isError()) { return nested; }
    if (nested.getItemCount() != 1 || nested.getProperty("behavior") != "hard_float") {
        throw new Exception("Nested references were not initialized before after-version");
    }
    return this;`;
