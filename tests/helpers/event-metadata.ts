import { referenceEvent, referenceMethod, referenceProject } from "./references.js";

const auditSchema = `<Item type="ItemType" action="add" id="METADATA_AUDIT">
    <name>MetadataAudit</name><Relationships>
        <Item type="Property" action="add"><name>phase</name><data_type>string</data_type></Item>
        <Item type="Property" action="add"><name>item_id</name><data_type>string</data_type></Item>
        <Item type="Property" action="add"><name>new_id</name><data_type>string</data_type></Item>
        <Item type="Property" action="add"><name>type_id</name><data_type>string</data_type></Item>
        <Item type="Property" action="add"><name>context_generation</name><data_type>string</data_type></Item>
        <Item type="Property" action="add"><name>context_name</name><data_type>string</data_type></Item>
        <Item type="Property" action="add"><name>ids</name><data_type>string</data_type></Item>
        <Item type="Property" action="add"><name>mapping</name><data_type>string</data_type></Item>
    </Relationships>
</Item>`;

const audit = `
    var audit = this.newItem("MetadataAudit", "add");
    audit.setProperty("item_id", this.getID());
    audit.setProperty("context_generation", this.getProperty("generation"));
    audit.setProperty("context_name", this.getProperty("name"));
`;

export function metadataMethod(name: string, source: string): string {
    return referenceMethod(
        name,
        `
        ${audit}
        ${source}
        var result = audit.apply();
        if (result.isError()) { return result; }
        return this;
    `,
    );
}

function beforeUpdate(): string {
    return metadataMethod(
        "MetadataBeforeUpdate",
        `
        if (eventData.Id != this.getID() || !eventData.IdList.Contains(this.getID())) {
            throw new Exception("The before-update ID list does not contain this Item");
        }
        audit.setProperty("phase", "BeforeUpdate");
        audit.setProperty("ids", string.Join(",", eventData.IdList));
    `,
    );
}

export function metadataProject(extra = "", bindVersionItem = true) {
    const versionItem = bindVersionItem
        ? metadataMethod(
              "MetadataVersionItem",
              `
            audit.setProperty("phase", "VersionItem");
            audit.setProperty("type_id", eventData.TypeId);
            audit.setProperty("new_id", eventData.NewItemId);
            audit.setProperty("ids", string.Join(",", eventData.NewItemsIds));
            audit.setProperty("mapping", Newtonsoft.Json.JsonConvert.SerializeObject(eventData.OldIdsNewIdsMap));
        `,
          ) + referenceEvent("REF_RECORD", "onAfterVersion", "MetadataVersionItem", { order: 10 })
        : "";

    return referenceProject(
        auditSchema +
            beforeUpdate() +
            referenceEvent("REF_RECORD", "onBeforeUpdate", "MetadataBeforeUpdate") +
            versionItem +
            extra,
    );
}
