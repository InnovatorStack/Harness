import { referenceEvent, referenceMethod, referenceProject } from "./references.js";

const auditSchema = `<Item type="ItemType" action="add" id="UNLOCK_AUDIT">
    <name>UnlockAudit</name><Relationships>
        <Item type="Property" action="add"><name>phase</name><data_type>string</data_type></Item>
        <Item type="Property" action="add"><name>record_id</name><data_type>string</data_type></Item>
        <Item type="Property" action="add"><name>context_name</name><data_type>string</data_type></Item>
        <Item type="Property" action="add"><name>context_marker</name><data_type>string</data_type></Item>
        <Item type="Property" action="add"><name>stored_owner</name><data_type>string</data_type></Item>
        <Item type="Property" action="add"><name>stored_marker</name><data_type>string</data_type></Item>
        <Item type="Property" action="add"><name>pending_note</name><data_type>string</data_type></Item>
    </Relationships>
</Item>`;

function capture(phase: "Before" | "After"): string {
    const name = `CaptureUnlock${phase}`;
    const source = referenceMethod(
        name,
        `
        var query = this.newItem(this.getType(), "get");
        query.setID(this.getID());
        var stored = query.apply();
        if (stored.isError()) { return stored; }

        var audit = this.newItem("UnlockAudit", "add");
        audit.setProperty("phase", "${phase}");
        audit.setProperty("record_id", this.getID());
        audit.setProperty("context_name", this.getProperty("name"));
        audit.setProperty("context_marker", this.getProperty("new_version"));
        audit.setProperty("stored_owner", stored.getProperty("locked_by_id"));
        audit.setProperty("stored_marker", stored.getProperty("new_version"));
        audit.setProperty("pending_note", this.getProperty("unlock_note"));
        var saved = audit.apply();
        if (saved.isError()) { return saved; }

        this.setProperty("unlock_note", "Retained across unlock callbacks");
        return this;
    `,
    );

    return source + referenceEvent("REF_RECORD", `on${phase}Unlock`, name);
}

const fixtures = `
    { name: "First locked source", new_version: 1, locked_by_id: { login_name: "reference_owner" } },
    { name: "Second locked source", new_version: 1, locked_by_id: { login_name: "reference_owner" } },
`;

export async function unlockProject(extra = "", fixtureData = "") {
    return await referenceProject(
        auditSchema + capture("Before") + capture("After") + extra,
        fixtureData,
        fixtures,
    );
}
