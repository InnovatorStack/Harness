import { referenceEvent, referenceMethod } from "./references.js";

const schema = `<Item type="ItemType" action="add" id="EDIT_AUDIT">
    <name>EditAudit</name><Relationships>
        <Item type="Property" action="add"><name>phase</name><data_type>string</data_type></Item>
        <Item type="Property" action="add"><name>pending_name</name><data_type>string</data_type></Item>
        <Item type="Property" action="add"><name>request_action</name><data_type>string</data_type></Item>
        <Item type="Property" action="add"><name>do_get_item</name><data_type>string</data_type></Item>
        <Item type="Property" action="add"><name>locked_count</name><data_type>integer</data_type></Item>
    </Relationships>
</Item>`;

function lockAudit(phase: "before" | "after"): string {
    const name = phase === "before" ? "BeforeEditLock" : "AfterEditLock";
    const event = phase === "before" ? "onBeforeLock" : "onAfterLock";
    const code = `
        var records = this.newItem(this.getType(), "get").apply();
        if (records.isError()) { return records; }
        int locked = 0;
        for (int index = 0; index < records.getItemCount(); index++) {
            if (!String.IsNullOrEmpty(records.getItemByIndex(index).getProperty("locked_by_id"))) {
                locked++;
            }
        }
        var audit = this.newItem("EditAudit", "add");
        audit.setProperty("phase", "${phase}");
        audit.setProperty("pending_name", this.getProperty("name"));
        audit.setProperty("request_action", this.getAction());
        audit.setProperty("do_get_item", this.getAttribute("doGetItem"));
        audit.setProperty("locked_count", locked.ToString());
        var result = audit.apply();
        if (result.isError()) { return result; }
        if ("${phase}" == "before") {
            this.setProperty("name", this.getProperty("name") + "/lock");
        }
        return this;
    `;

    return referenceMethod(name, code) + referenceEvent("REF_RECORD", event, name);
}

export const editLockSources = schema + lockAudit("before") + lockAudit("after");
