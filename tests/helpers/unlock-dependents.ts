import { referenceEvent } from "./references.js";
import { unlockProject } from "./unlock-events.js";

function itemType(id: string, name: string, dependent: boolean): string {
    return `<Item type="ItemType" action="add" id="${id}">
        <name>${name}</name><is_versionable>1</is_versionable><is_dependent>${dependent ? 1 : 0}</is_dependent>
        <Relationships><Item type="Property" action="add"><name>name</name><data_type>string</data_type></Item></Relationships>
    </Item>`;
}

function relationship(name: string, source: string, related: string): string {
    return `<Item type="ItemType" action="add" id="${name}">
        <name>${name}</name><is_relationship>1</is_relationship>
    </Item><Item type="RelationshipType" action="add">
        <name>${name}</name><relationship_id>${name}</relationship_id>
        <source_id>${source}</source_id><related_id>${related}</related_id>
    </Item>`;
}

function hooks(type: string): string {
    return (
        referenceEvent(type, "onBeforeUnlock", "CaptureUnlockBefore") +
        referenceEvent(type, "onAfterUnlock", "CaptureUnlockAfter")
    );
}

const otherUser = `<Item type="User" action="add" id="CF100000000000000000000000000001">
    <login_name>other_lock_owner</login_name><created_on>2026-01-01T00:00:00</created_on>
    <created_by_id>CF100000000000000000000000000001</created_by_id>
</Item>`;

const metadata =
    otherUser +
    itemType("UNLOCK_CHILD", "UnlockChild", true) +
    itemType("UNLOCK_LEAF", "UnlockLeaf", true) +
    itemType("UNLOCK_REGULAR", "UnlockRegular", false) +
    relationship("UnlockChildren", "REF_RECORD", "UNLOCK_CHILD") +
    relationship("UnlockLeaves", "UNLOCK_CHILD", "UNLOCK_LEAF") +
    relationship("UnlockRegulars", "REF_RECORD", "UNLOCK_REGULAR") +
    hooks("UNLOCK_CHILD") +
    hooks("UNLOCK_LEAF");

const fixtures = `
    UnlockChild: [
        { name: "Owned child", new_version: 1, locked_by_id: { login_name: "reference_owner" } },
        { name: "Other owner's child", new_version: 1, locked_by_id: { login_name: "other_lock_owner" } },
    ],
    UnlockLeaf: [{ name: "Nested leaf", new_version: 1, locked_by_id: { login_name: "reference_owner" } }],
    UnlockRegular: [{ name: "Regular child", new_version: 1, locked_by_id: { login_name: "reference_owner" } }],
    UnlockChildren: [
        { source_id: { name: "First locked source" }, related_id: { name: "Owned child" } },
        { source_id: { name: "First locked source" }, related_id: { name: "Other owner's child" } },
    ],
    UnlockLeaves: [{ source_id: { name: "Owned child" }, related_id: { name: "Nested leaf" } }],
    UnlockRegulars: [{ source_id: { name: "First locked source" }, related_id: { name: "Regular child" } }],
`;

export function dependentUnlockProject(extra = "", extraFixtures = "") {
    return unlockProject(metadata + extra, fixtures + extraFixtures);
}
