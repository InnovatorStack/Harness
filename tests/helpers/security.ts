import { referenceProject } from "./references.js";

function access(identity: string, rights: readonly string[]): string {
    return `<Item type="Access" action="add"><related_id>${identity}</related_id>
        ${rights.map((right) => `<can_${right}>1</can_${right}>`).join("\n")}</Item>`;
}

function permission(id: string, grants: string): string {
    return `<Item type="Permission" action="add" id="${id}"><name>${id}</name><Relationships>${grants}</Relationships></Item>`;
}

const identities = `<Item type="Identity" action="add" id="SEC_ALIAS"><name>Test contributor</name><is_alias>1</is_alias></Item>
    <Item type="Identity" action="add" id="SEC_READERS"><name>Test readers</name></Item>
    <Item type="Identity" action="add" id="SEC_EDITORS"><name>Test editors</name></Item>
    <Item type="Identity" action="add" id="SEC_PUBLISHERS"><name>Test publishers</name></Item>`;

const permissions =
    permission("SEC_EDIT", access("SEC_EDITORS", ["get", "update", "delete"])) +
    permission("SEC_READ", access("A73B655731924CD0B027E4F4D5FCC0A9", ["get"])) +
    permission(
        "SEC_HIDDEN",
        access("2618D6F5A90949BAA7E920D1B04C7EE1", ["get", "update", "delete"]),
    ) +
    permission(
        "SEC_PUBLISH",
        access("A73B655731924CD0B027E4F4D5FCC0A9", ["get"]) +
            access("SEC_PUBLISHERS", ["get", "update", "delete", "change_access"]),
    ) +
    permission("SEC_OWNER", access("538B300BB2A347F396C436E9EEE1976C", ["get", "update"])) +
    permission("SEC_CREATOR", access("8FE5430B42014D94AE83246F299D9CC4", ["get", "update"])) +
    permission("SEC_MANAGER", access("9200A800443E4A5AAA80D0BCE5760307", ["get", "update"]));

const model = `<Item type="ItemType" action="add" id="SEC_DOCUMENT"><name>SecurityDocument</name><is_versionable>1</is_versionable><Relationships>
    <Item type="Property" action="add"><name>name</name><data_type>string</data_type></Item>
    <Item type="Property" action="add"><name>link</name><data_type>item</data_type><data_source>SEC_DOCUMENT</data_source></Item>
    <Item type="Property" action="add"><name>permission_id</name><data_type>item</data_type><data_source>C6A89FDE1294451497801DF78341B473</data_source></Item>
    <Item type="Property" action="add"><name>owned_by_id</name><data_type>item</data_type><data_source>E582AB17663F4EF28460015B2BE9E094</data_source></Item>
    <Item type="Property" action="add"><name>managed_by_id</name><data_type>item</data_type><data_source>E582AB17663F4EF28460015B2BE9E094</data_source></Item>
    <Item type="Property" action="add"><name>created_by_id</name><data_type>item</data_type><data_source>45E899CD2859442982EB22BB2DF683E5</data_source></Item>
</Relationships></Item>
<Item type="Allowed Permission" action="add"><source_id>SEC_DOCUMENT</source_id><related_id>SEC_EDIT</related_id><is_default>1</is_default></Item>
<Item type="Allowed Permission" action="add"><source_id>SEC_DOCUMENT</source_id><related_id>SEC_READ</related_id></Item>
<Item type="Can Add" action="add"><source_id>SEC_DOCUMENT</source_id><related_id>SEC_EDITORS</related_id></Item>`;

const audit = 'created_on: "2026-01-01T00:00:00", created_by_id: { login_name: "reference_owner" }';

export const principalFixtures = `
    Alias: [{ ${audit}, source_id: { login_name: "reference_owner" }, related_id: { name: "Test contributor" } }],
    Member: [
        { ${audit}, source_id: { name: "Test editors" }, related_id: { name: "Test contributor" } },
        { ${audit}, source_id: { name: "Test readers" }, related_id: { name: "Test editors" } },
    ],
    UserMessage: [{ name: "Test_Required", text: "A value is required for {0}.",
        permission_id: { name: "SEC_READ" }, created_on: "2026-01-01T00:00:00",
        created_by_id: { login_name: "reference_owner" } }],
`;

export const securityFixtures = `${principalFixtures}
    SecurityDocument: [
        { name: "Editable", permission_id: { name: "SEC_EDIT" } },
        { name: "Read only", permission_id: { name: "SEC_READ" } },
        { name: "Hidden", permission_id: { name: "SEC_HIDDEN" } },
        { name: "Publish controlled", permission_id: { name: "SEC_PUBLISH" } },
    ],
`;

export function securityProject(extra = "", fixtures = securityFixtures) {
    return referenceProject(identities + permissions + model + extra, fixtures);
}
