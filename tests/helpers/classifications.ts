import { principalFixtures, securityProject } from "./security.js";

interface ClassificationOptions {
    readonly versionable?: boolean;
    readonly permission?: string;
    readonly fixtures?: string;
}

const permissionProperty = `<Item type="Property" action="add">
    <name>permission_id</name><data_type>item</data_type><data_source>C6A89FDE1294451497801DF78341B473</data_source>
</Item>`;

const classes = `<class>
    <class name="Design"><class name="Mechanical" /><class name="Electrical" /></class>
    <class name="Operations" />
    <class name="Restricted" />
    <class name="Plain" />
    <class name="Legacy" />
</class>`;

function grant(path: string, identity = "SEC_EDITORS"): string {
    return `<Item type="Can Add" action="add"><class_path>${path}</class_path>
        <related_id>${identity}</related_id><can_add>1</can_add>
    </Item>`;
}

function lifecycle(permission: string): string {
    return `<Item type="Life Cycle Map" action="add" id="CLASS_DESIGN_MAP">
        <name>Design lifecycle</name><start_state>CLASS_DESIGN_START</start_state>
        <Relationships>
            <Item type="Life Cycle State" action="add" id="CLASS_DESIGN_START">
                <name>Design draft</name><item_behavior>fixed</item_behavior>
            </Item>
            <Item type="Life Cycle State" action="add" id="CLASS_DESIGN_REVIEW">
                <name>Design review</name><item_behavior>fixed</item_behavior>
            </Item>
            <Item type="Life Cycle Transition" action="add">
                <from_state>CLASS_DESIGN_START</from_state><to_state>CLASS_DESIGN_REVIEW</to_state>
            </Item>
        </Relationships>
    </Item>
    <Item type="Life Cycle Map" action="add" id="CLASS_OPERATIONS_MAP">
        <name>Operations lifecycle</name><start_state>CLASS_OPERATIONS_START</start_state>
        <Relationships>
            <Item type="Life Cycle State" action="add" id="CLASS_OPERATIONS_START">
                <name>Operations draft</name><state_permission_id>${permission}</state_permission_id>
                <item_behavior>float</item_behavior>
            </Item>
        </Relationships>
    </Item>
    <Item type="ItemType Life Cycle" action="add">
        <source_id>CLASS_RECORD</source_id><related_id>CLASS_DESIGN_MAP</related_id><class_path>Design</class_path>
    </Item>
    <Item type="ItemType Life Cycle" action="add">
        <source_id>CLASS_RECORD</source_id><related_id>CLASS_OPERATIONS_MAP</related_id><class_path>Operations</class_path>
    </Item>
    <Item type="ItemType Life Cycle" action="add">
        <source_id>CLASS_RECORD</source_id><related_id>CLASS_OPERATIONS_MAP</related_id><class_path>Restricted</class_path>
    </Item>`;
}

const relationships = `<Item type="ItemType" action="add" id="CLASS_LINK">
    <name>ClassificationLink</name><is_relationship>1</is_relationship><use_src_access>1</use_src_access>
    <class_structure><![CDATA[<class><class name="Linked" /><class name="Alternate" /></class>]]></class_structure>
    <Relationships>
        <Item type="Property" action="add"><name>name</name><data_type>string</data_type></Item>
        ${permissionProperty}
    </Relationships>
</Item>
<Item type="RelationshipType" action="add">
    <name>ClassificationLink</name><relationship_id>CLASS_LINK</relationship_id>
    <source_id>CLASS_RECORD</source_id><related_id>CLASS_RECORD</related_id><behavior>fixed</behavior>
</Item>`;

const records = `ClassificationRecord: [
    { name: "Start", classification: "Design/Mechanical", permission_id: { name: "SEC_EDIT" } },
    { name: "Advanced", classification: "Design/Mechanical", state: "Design review", permission_id: { name: "SEC_EDIT" } },
    { name: "Unmapped", classification: "Plain", permission_id: { name: "SEC_EDIT" } },
    { name: "Legacy", classification: "Legacy", permission_id: { name: "SEC_EDIT" } },
],
ClassificationLink: [{ name: "Owned", classification: "Linked", source_id: { name: "Start" },
    related_id: { name: "Unmapped" }, permission_id: { name: "SEC_EDIT" }, modified_on: "2026-01-02T00:00:00" }],`;

export function classificationProject(extra = "", options: ClassificationOptions = {}) {
    const model = `<Item type="ItemType" action="add" id="CLASS_RECORD">
        <name>ClassificationRecord</name><is_versionable>${options.versionable ? 1 : 0}</is_versionable>
        <class_structure><![CDATA[${classes}]]></class_structure>
        <Relationships>
            <Item type="Property" action="add"><name>name</name><data_type>string</data_type></Item>
            ${permissionProperty}
            <Item type="Allowed Permission" action="add">
                <related_id>SEC_EDIT</related_id><is_default>1</is_default>
            </Item>
            <Item type="Allowed Permission" action="add"><related_id>SEC_READ</related_id></Item>
            ${grant("Design")}${grant("Operations")}${grant("Plain")}${grant("Restricted", "SEC_PUBLISHERS")}
        </Relationships>
    </Item>`;

    return securityProject(
        model + relationships + lifecycle(options.permission ?? "SEC_EDIT") + extra,
        principalFixtures + (options.fixtures ?? records),
    );
}
