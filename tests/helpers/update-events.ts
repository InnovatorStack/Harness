import { referenceEvent, referenceMethod } from "./references.js";

const schema = `<Item type="ItemType" action="add" id="UPDATE_AUDIT">
    <name>UpdateAudit</name><Relationships>
        <Item type="Property" action="add"><name>phase</name><data_type>string</data_type></Item>
        <Item type="Property" action="add"><name>record_id</name><data_type>string</data_type></Item>
        <Item type="Property" action="add"><name>old_id</name><data_type>string</data_type></Item>
        <Item type="Property" action="add"><name>request_action</name><data_type>string</data_type></Item>
        <Item type="Property" action="add"><name>pending_name</name><data_type>string</data_type></Item>
        <Item type="Property" action="add"><name>stored_name</name><data_type>string</data_type></Item>
        <Item type="Property" action="add"><name>pending_marker</name><data_type>string</data_type></Item>
        <Item type="Property" action="add"><name>stored_marker</name><data_type>string</data_type></Item>
        <Item type="Property" action="add"><name>current_marker</name><data_type>string</data_type></Item>
    </Relationships>
</Item>`;

const beforeUpdate = referenceMethod(
    "ObserveUpdate",
    `
    string oldId = this.getAttribute("oldId");
    string phase = String.IsNullOrEmpty(oldId) ? "preflight" : "reentry";
    string requestedName = this.getProperty("name");
    var query = this.newItem("ReferenceRecord", "get");
    query.setID(this.getID());
    var stored = query.apply();
    if (stored.isError()) { return stored; }

    var audit = this.newItem("UpdateAudit", "add");
    audit.setProperty("phase", phase);
    audit.setProperty("record_id", this.getID());
    audit.setProperty("old_id", oldId);
    audit.setProperty("request_action", this.getAction());
    audit.setProperty("pending_name", requestedName);
    audit.setProperty("stored_name", stored.getProperty("name"));
    audit.setProperty("pending_marker", this.getProperty("new_version"));
    audit.setProperty("stored_marker", stored.getProperty("new_version"));
    var added = audit.apply();
    if (added.isError()) { return added; }

    if (requestedName == "Suppress generation") {
        this.setAttribute("version", "0");
        this.setProperty("name", "Saved in place");
    }
    if (requestedName == "Change preflight" && phase == "preflight") {
        this.setProperty("name", "Preflight value");
    }
    if (requestedName == "Reject preflight" && phase == "preflight") {
        return this.getInnovator().newError("Rejected before versioning");
    }
    if (requestedName == "Reject reentry" && phase == "reentry") {
        return this.getInnovator().newError("Rejected after versioning");
    }
    return this;
`,
);

const beforeVersion = referenceMethod(
    "ObserveVersion",
    `
    var query = this.newItem("ReferenceRecord", "get");
    query.setID(this.getID());
    var stored = query.apply();
    if (stored.isError()) { return stored; }

    var audit = this.newItem("UpdateAudit", "add");
    audit.setProperty("phase", "version");
    audit.setProperty("record_id", this.getID());
    audit.setProperty("request_action", this.getAction());
    audit.setProperty("pending_name", this.getProperty("name"));
    audit.setProperty("stored_name", stored.getProperty("name"));
    audit.setProperty("current_marker", stored.getProperty("is_current"));
    var added = audit.apply();
    if (added.isError()) { return added; }
    return this;
`,
);

export const updateEventSources =
    schema +
    beforeUpdate +
    referenceEvent("REF_RECORD", "onBeforeUpdate", "ObserveUpdate", { required: true }) +
    beforeVersion +
    referenceEvent("REF_RECORD", "onBeforeVersion", "ObserveVersion");
