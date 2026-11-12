import { expect, spyOn, test } from "bun:test";
import { join } from "node:path";

import { inspectSecurity } from "../src/compatibility/security.js";
import { dataDepthMax } from "../src/core/limits.js";
import { createEngine } from "../src/engine.js";
import {
    AuthorizationMode,
    CapabilityId,
    checkCompatibility,
    CompatibilityIssueCode,
    createHarness,
    ExecutionOutcome,
    FailurePoint,
    ItemAction,
    IssueSeverity,
} from "../src/index.js";
import { referenceEvent, referenceMethod } from "./helpers/references.js";
import { principalFixtures, securityFixtures, securityProject } from "./helpers/security.js";

const schema = `
<Item type="ItemType" action="add" id="SEC_LINK">
    <name>SecurityLink</name>
    <is_relationship>1</is_relationship>
    <use_src_access>1</use_src_access>
    <Relationships>
        <Item type="Property" action="add">
            <name>name</name><data_type>string</data_type>
        </Item>
        <Item type="Property" action="add">
            <name>permission_id</name><data_type>item</data_type>
            <data_source>C6A89FDE1294451497801DF78341B473</data_source>
        </Item>
        <Item type="Property" action="add">
            <name>created_by_id</name><data_type>item</data_type>
            <data_source>45E899CD2859442982EB22BB2DF683E5</data_source>
        </Item>
    </Relationships>
</Item>
<Item type="RelationshipType" action="add">
    <name>SecurityLink</name><relationship_id>SEC_LINK</relationship_id>
    <source_id>SEC_DOCUMENT</source_id><related_id>SEC_DOCUMENT</related_id>
</Item>
<Item type="ItemType" action="add" id="SEC_NESTED_LINK">
    <name>SecurityNestedLink</name>
    <is_relationship>1</is_relationship>
    <use_src_access>1</use_src_access>
    <Relationships>
        <Item type="Property" action="add">
            <name>name</name><data_type>string</data_type>
        </Item>
        <Item type="Property" action="add">
            <name>permission_id</name><data_type>item</data_type>
            <data_source>C6A89FDE1294451497801DF78341B473</data_source>
        </Item>
    </Relationships>
</Item>
<Item type="RelationshipType" action="add">
    <name>SecurityNestedLink</name><relationship_id>SEC_NESTED_LINK</relationship_id>
    <source_id>SEC_LINK</source_id>
</Item>`;

const fixtures = `${securityFixtures}
    SecurityLink: [
        { name: "A denied link", source_id: { name: "Hidden" },
          related_id: { name: "Read only" }, permission_id: { name: "SEC_HIDDEN" } },
        { name: "B visible link", source_id: { name: "Read only" },
          related_id: { name: "Hidden" }, permission_id: { name: "SEC_READ" } },
        { name: "C editable source", source_id: { name: "Editable" },
          permission_id: { name: "SEC_EDIT" } },
    ],
    SecurityNestedLink: [
        { name: "Nested", source_id: { name: "B visible link" },
          permission_id: { name: "SEC_READ" } },
    ],
`;

const accessChanges = `
<Item type="Access" action="add">
    <source_id>SEC_EDIT</source_id><related_id>SEC_EDITORS</related_id>
    <can_change_access>1</can_change_access>
</Item>
<Item type="Allowed Permission" action="add">
    <source_id>SEC_DOCUMENT</source_id><related_id>SEC_HIDDEN</related_id>
</Item>`;

const indexedPermission = `<Item type="Permission" action="add" id="SEC_INDEX">
    <name>Indexed access</name><Relationships><Item type="Access" action="add">
        <related_id>A73B655731924CD0B027E4F4D5FCC0A9</related_id><can_get>1</can_get><can_update>1</can_update>
    </Item></Relationships>
</Item>`;

const cycleSchema = `
<Item type="ItemType" action="add" id="SEC_CYCLE_LINK">
    <name>SecurityCycleLink</name><is_relationship>1</is_relationship>
    <use_src_access>1</use_src_access>
    <Relationships>
        <Item type="Property" action="add">
            <name>name</name><data_type>string</data_type>
        </Item>
    </Relationships>
</Item>
<Item type="RelationshipType" action="add">
    <name>SecurityCycleLink</name><relationship_id>SEC_CYCLE_LINK</relationship_id>
    <source_id>SEC_CYCLE_LINK</source_id>
</Item>`;

test("relationship reads use copied ACLs before paging and leave stored permission values intact", async () => {
    await using project = await securityProject(schema, fixtures);
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });
    const before = h.state.get("SecurityLink");
    const result = await h.applyAML(
        '<Item type="SecurityLink" action="get" orderBy="name" pagesize="1" />',
    );

    expect(result.getProperty("name")).toBe("B visible link");
    expect(result.getProperty("permission_id")).toBe("SEC_READ");
    expect(result.payload.messages).toContainEqual({ name: "itemmax", value: "2" });
    expect(await h.get("SecurityLink", { name: "A denied link" })).toEqual([]);
    expect(h.state.get("SecurityLink")).toEqual(before);
});

test("source access follows nested relationship owners and never grants a protected related Item", async () => {
    await using project = await securityProject(schema, fixtures);
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });
    const nested = await h.getOne("SecurityNestedLink", { name: "Nested" });
    const result = await h.applyAML(`
        <Item type="SecurityLink" action="get" select="name,related_id(name)">
            <name>B visible link</name>
        </Item>`);

    expect(nested.properties.permission_id).toBe("SEC_READ");
    expect(result.getProperty("related_id")).toBe(
        h.state.getOne("SecurityDocument", { name: "Hidden" }).id,
    );
    expect(result.node.propertyItems.related_id).toBeUndefined();
});

test.each([
    { sourceCreator: "reference_owner", linkCreator: "admin", readable: false },
    { sourceCreator: "admin", linkCreator: "reference_owner", readable: true },
])("Creator access belongs to the relationship's actual creator: %s", async (scenario) => {
    const data = fixtures
        .replace(
            '{ name: "Read only", permission_id: { name: "SEC_READ" } }',
            `{ name: "Read only", permission_id: { name: "SEC_CREATOR" },
                created_by_id: { login_name: "${scenario.sourceCreator}" } }`,
        )
        .replace(
            'name: "B visible link",',
            `name: "B visible link", created_by_id: { login_name: "${scenario.linkCreator}" },`,
        )
        .replace(
            'related_id: { name: "Hidden" }, permission_id: { name: "SEC_READ" }',
            'related_id: { name: "Hidden" }, permission_id: { name: "SEC_CREATOR" }',
        );
    await using project = await securityProject(schema, data);
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });

    expect(await h.get("SecurityLink", { name: "B visible link" })).toHaveLength(
        scenario.readable ? 1 : 0,
    );
});

test("permission resolution reads stored sources without invoking their get Methods", async () => {
    const trap =
        referenceMethod("RejectSourceGet", 'throw new Exception("Do not invoke source hooks");') +
        referenceEvent("SEC_DOCUMENT", "onBeforeGet", "RejectSourceGet");
    await using project = await securityProject(schema + trap, fixtures);
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });

    expect(await h.get("SecurityLink")).toHaveLength(2);
    expect(
        h.trace.some((event) => event.kind === "method" && event.name === "RejectSourceGet"),
    ).toBe(false);
});

test("original C# reads pass through the same source permission policy", async () => {
    const method = referenceMethod(
        "ReadInheritedLinks",
        'return this.getInnovator().newItem("SecurityLink", "get").apply();',
    );
    await using project = await securityProject(schema + method, fixtures);
    using h = await createHarness({
        cwd: project.cwd,
        authorization: AuthorizationMode.Native,
        csharp: {},
    });
    const result = await h.callMethod("ReadInheritedLinks");

    expect(result.isError()).toBe(false);
    expect(result.getItemCount()).toBe(2);
    expect(h.executions.at(-1)?.calls[0]?.executed).toBe(true);
    expect(h.executions.at(-1)?.mocks).toHaveLength(0);
}, 60_000);

test("direct inherited edits use copied update rights without requiring relationship Can Add metadata", async () => {
    await using project = await securityProject(schema, fixtures);
    const options = { cwd: project.cwd, authorization: AuthorizationMode.Native };
    using h = await createHarness(options);
    const link = await h.getOne("SecurityLink", { name: "C editable source" });
    const updated = await h.update(link, { name: "Saved" });

    expect(updated.id).toBe(link.id);
    expect(h.state.getOne("SecurityLink", { id: link.id }).properties).toMatchObject({
        name: "Saved",
        permission_id: "SEC_EDIT",
        source_id: link.properties.source_id,
    });
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.Committed);
    const report = await checkCompatibility(options);
    expect(report.issues.some((issue) => issue.causeCode === "UnsupportedSourceAccess")).toBe(
        false,
    );
});

test("a missing source fails closed with its original schema location", async () => {
    await using project = await securityProject(schema);
    let actor = "";
    using engine = createEngine({
        authorization: AuthorizationMode.Native,

        userId: () => actor,
    });
    const administrator = engine.storage
        .listItems("User")
        .find((item) => item.properties.login_name === "admin");

    if (!administrator) {
        throw new Error("The standard baseline must provide its administrator User.");
    }

    actor = administrator.id;
    const imported = await engine.loadPackages([join(project.cwd, ".harness/packages/source.xml")]);
    expect(imported.documents).toHaveLength(1);
    const source = engine.seed("SecurityDocument", { name: "Source", permission_id: "SEC_READ" });
    engine.seed("SecurityLink", { name: "Orphan", source_id: source, permission_id: "SEC_READ" });
    engine.storage.deleteItem(source.type, source.id);
    await expect(
        engine.applyAML('<Item type="SecurityLink" action="get" />'),
    ).rejects.toMatchObject({
        code: "MissingSourceItem",
        capability: CapabilityId.NativePermissions,
        source: { file: imported.documents[0]?.path },
    });
});

test("source ACL changes are visible immediately and remain isolated across worlds and reset", async () => {
    await using project = await securityProject(schema + accessChanges, fixtures);
    const options = { cwd: project.cwd, authorization: AuthorizationMode.Native };
    using h = await createHarness(options);
    using other = await createHarness(options);
    const source = await h.getOne("SecurityDocument", { name: "Editable" });
    const hidden = h.state.getOne("Permission", { name: "SEC_HIDDEN" });
    await h.applyAML(`
        <Item type="SecurityDocument" action="edit" version="0" id="${source.id}" doGetItem="0">
            <permission_id>${hidden.id}</permission_id>
        </Item>`);

    expect(await h.get("SecurityLink", { name: "C editable source" })).toEqual([]);
    expect(await other.get("SecurityLink", { name: "C editable source" })).toHaveLength(1);
    h.reset();
    expect(await h.get("SecurityLink", { name: "C editable source" })).toHaveLength(1);
});

test("rolling back a source permission change restores inherited reads", async () => {
    await using project = await securityProject(schema + accessChanges, fixtures);
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });
    const source = await h.getOne("SecurityDocument", { name: "Editable" });
    const hidden = h.state.getOne("Permission", { name: "SEC_HIDDEN" });
    const before = h.state.get("SecurityDocument");
    const links = h.state.get("SecurityLink");
    using failure = h.injectFailure({
        type: "SecurityDocument",
        action: ItemAction.Edit,
        at: FailurePoint.AfterCall,
        error: new Error("Reject the permission change"),
    });
    await expect(
        h.applyAML(`<Item type="SecurityDocument" action="edit" version="0" id="${source.id}" doGetItem="0">
            <permission_id>${hidden.id}</permission_id></Item>`),
    ).rejects.toThrow("Reject the permission change");

    expect(failure.triggered).toBe(true);
    expect(h.state.get("SecurityDocument")).toEqual(before);
    expect(h.state.get("SecurityLink")).toEqual(links);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
    expect(await h.get("SecurityLink", { name: "C editable source" })).toHaveLength(1);
});

test("inherited creation copies security fields while keeping the relationship's own audit identity", async () => {
    const data = fixtures.replace(
        '{ name: "Editable", permission_id: { name: "SEC_EDIT" } }',
        `{ name: "Editable", permission_id: { name: "SEC_EDIT" },
            created_by_id: { login_name: "admin" }, owned_by_id: { name: "Test readers" },
            managed_by_id: { name: "Test editors" } }`,
    );
    await using project = await securityProject(schema, data);
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });
    const parent = await h.getOne("SecurityDocument", { name: "Editable" });
    const related = h.state.getOne("SecurityDocument", { name: "Hidden" });
    const actor = h.state.getOne("User", { login_name: "reference_owner" });
    const link = await h.add("SecurityLink", {
        name: "Created",
        source_id: parent.id,
        related_id: related.id,
        permission_id: "SEC_HIDDEN",
        owned_by_id: null,
    });

    expect(h.state.getOne("SecurityLink", { id: link.id }).properties).toMatchObject({
        permission_id: parent.properties.permission_id,
        owned_by_id: parent.properties.owned_by_id,
        managed_by_id: parent.properties.managed_by_id,
        team_id: null,
        source_id: parent.id,
        related_id: related.id,
        created_by_id: actor.id,
    });
    expect(link.properties.created_by_id).not.toBe(parent.properties.created_by_id);
    expect(await h.get("SecurityDocument", { name: "Hidden" })).toEqual([]);
});

test("inherited creation and propagation resolve the source's declared default Permission", async () => {
    const data = fixtures.replace(
        '{ name: "Editable", permission_id: { name: "SEC_EDIT" } }',
        '{ name: "Editable" }',
    );
    await using project = await securityProject(schema, data);
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });
    const parent = await h.getOne("SecurityDocument", { name: "Editable" });
    const link = await h.add("SecurityLink", { source_id: parent.id, name: "Default ACL" });

    expect(link.properties.permission_id).toBe("SEC_EDIT");
    const result = await h.applyAML(
        `<Item type="SecurityDocument" action="edit" version="0" id="${parent.id}"><owned_by_id>SEC_READERS</owned_by_id></Item>`,
    );
    expect(result.isError()).toBe(false);
    expect(h.state.getOne("SecurityLink", { id: link.id }).properties).toMatchObject({
        permission_id: "SEC_EDIT",
        owned_by_id: "SEC_READERS",
    });
});

test("source authorization bypasses relationship Can Add rules while preserving class validation", async () => {
    const source = `${schema}<Item type="ItemType" action="edit" id="SEC_LINK">
        <class_structure><![CDATA[<class><class name="Known" /></class>]]></class_structure>
    </Item>`;
    await using project = await securityProject(source, fixtures);
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });
    const parent = await h.getOne("SecurityDocument", { name: "Editable" });
    const link = await h.add("SecurityLink", { source_id: parent.id, classification: "Known" });

    expect(link.properties.classification).toBe("Known");
    await expect(
        h.add("SecurityLink", { source_id: parent.id, classification: "Unknown" }),
    ).rejects.toThrow("unknown class");
    expect(h.state.get("SecurityLink", { source_id: parent.id })).toHaveLength(2);
});

test("for_all inherited sources have matching preflight and runtime capability diagnostics", async () => {
    const source = `<Item type="ItemType" action="add" id="SEC_ALL_LINK">
        <name>SecurityAllLink</name><is_relationship>1</is_relationship><use_src_access>1</use_src_access>
    </Item><Item type="RelationshipType" action="add">
        <name>SecurityAllLink</name><relationship_id>SEC_ALL_LINK</relationship_id><source_id is_null="1" />
    </Item>`;
    await using project = await securityProject(schema + source, fixtures);
    const options = { cwd: project.cwd, authorization: AuthorizationMode.Native };
    using h = await createHarness(options);
    const parent = await h.getOne("SecurityDocument", { name: "Editable" });
    await expect(h.add("SecurityAllLink", { source_id: parent.id })).rejects.toMatchObject({
        code: "UnsupportedSourceAccess",
        capability: CapabilityId.NativePermissions,
    });
    const report = await checkCompatibility(options);

    expect(
        report.issues.some(
            (issue) =>
                issue.causeCode === "UnsupportedSourceAccess" && issue.message.includes("for_all"),
        ),
    ).toBe(true);
    expect(h.state.get("SecurityAllLink")).toEqual([]);
});

test("read-only source rights cannot add, edit or delete inherited relationships", async () => {
    await using project = await securityProject(schema, fixtures);
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });
    const parent = await h.getOne("SecurityDocument", { name: "Read only" });
    const link = await h.getOne("SecurityLink", { name: "B visible link" });
    const before = h.state.get("SecurityLink");
    await expect(h.add("SecurityLink", { source_id: parent.id, name: "Denied" })).rejects.toThrow(
        "Permission denied",
    );
    await expect(h.update(link, { name: "Denied" })).rejects.toThrow("Permission denied");
    const removed = await h.applyAML(
        `<Item type="SecurityLink" action="delete" id="${link.id}" />`,
    );

    expect(removed.getErrorCode()).toBe("PermissionDenied");
    expect(h.state.get("SecurityLink")).toEqual(before);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
});

test("nested inherited add, edit and delete use the ordinary action pipeline", async () => {
    await using project = await securityProject(schema, fixtures);
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });
    const parent = await h.getOne("SecurityDocument", { name: "Editable" });
    const created =
        await h.applyAML(`<Item type="SecurityDocument" action="edit" version="0" id="${parent.id}">
        <Relationships><Item type="SecurityLink" action="add"><name>Nested creation</name></Item></Relationships>
    </Item>`);
    expect(created.isError()).toBe(false);
    const link = await h.getOne("SecurityLink", { name: "Nested creation" });
    const edited =
        await h.applyAML(`<Item type="SecurityDocument" action="edit" version="0" id="${parent.id}">
        <Relationships><Item type="SecurityLink" action="edit" id="${link.id}"><name>Nested edit</name></Item></Relationships>
    </Item>`);
    expect(edited.isError()).toBe(false);
    expect(h.state.getOne("SecurityLink", { id: link.id }).properties.name).toBe("Nested edit");
    const deleted =
        await h.applyAML(`<Item type="SecurityDocument" action="edit" version="0" id="${parent.id}">
        <Relationships><Item type="SecurityLink" action="delete" id="${link.id}" /></Relationships>
    </Item>`);

    expect(deleted.isError()).toBe(false);
    expect(h.state.get("SecurityLink", { id: link.id })).toEqual([]);
    expect(h.state.get("SecurityDocument", { config_id: parent.id })).toHaveLength(1);
});

test("deleting an inherited relationship needs Update rather than Delete access", async () => {
    const data = fixtures.replace(
        '{ name: "Editable", permission_id: { name: "SEC_EDIT" } }',
        `{ name: "Editable", permission_id: { name: "SEC_OWNER" }, owned_by_id: { name: "Test editors" } }`,
    );
    await using project = await securityProject(schema, data);
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });
    const parent = await h.getOne("SecurityDocument", { name: "Editable" });
    const link = await h.add("SecurityLink", { source_id: parent.id });
    const result = await h.applyAML(`<Item type="SecurityLink" action="delete" id="${link.id}" />`);

    expect(result.isError()).toBe(false);
    expect(h.state.get("SecurityLink", { id: link.id })).toEqual([]);
    const rejected = await h.applyAML(
        `<Item type="SecurityDocument" action="delete" id="${parent.id}" />`,
    );
    expect(rejected.getErrorCode()).toBe("PermissionDenied");
    expect(h.state.get("SecurityDocument", { id: parent.id })).toHaveLength(1);
});

test("source security propagation updates nested rows, preserves audit data and restores on reset", async () => {
    const data = fixtures.replace(
        '{ name: "Nested", source_id: { name: "B visible link" },\n          permission_id: { name: "SEC_READ" } }',
        '{ name: "Editable nested", source_id: { name: "C editable source" },\n          permission_id: { name: "SEC_EDIT" } }',
    );
    await using project = await securityProject(schema + accessChanges, data);
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });
    const parent = await h.getOne("SecurityDocument", { name: "Editable" });
    const link = h.state.getOne("SecurityLink", { name: "C editable source" });
    const nested = h.state.getOne("SecurityNestedLink", { name: "Editable nested" });
    const result =
        await h.applyAML(`<Item type="SecurityDocument" action="edit" version="0" id="${parent.id}">
        <permission_id>SEC_READ</permission_id><owned_by_id>SEC_READERS</owned_by_id>
    </Item>`);

    expect(result.isError()).toBe(false);

    for (const record of [link, nested]) {
        const after = h.state.getOne(record.type, { id: record.id });
        expect(after.properties).toMatchObject({
            permission_id: "SEC_READ",
            owned_by_id: "SEC_READERS",
        });
        expect(after.properties.created_by_id).toBe(record.properties.created_by_id);
        expect(after.properties.modified_on).toBe(record.properties.modified_on);
    }

    expect(
        h.executions.at(-1)?.changes.filter((change) => change.name === "inherit-permissions"),
    ).toHaveLength(2);
    h.reset();
    expect(h.state.getOne("SecurityLink", { id: link.id })).toEqual(link);
    expect(h.state.getOne("SecurityNestedLink", { id: nested.id })).toEqual(nested);
});

test("ACL schema work stays bounded as the number of owned relationships grows", async () => {
    await using project = await securityProject(schema + indexedPermission);
    let actor = "";
    using engine = createEngine({
        authorization: AuthorizationMode.Native,

        userId: () => actor,
    });
    const user = engine.storage
        .listItems("User")
        .find((record) => record.properties.login_name === "admin");

    if (!user) {
        throw new Error("The baseline must supply its administrator User.");
    }

    actor = user.id;
    await engine.loadPackages([join(project.cwd, ".harness/packages/source.xml")]);
    const parent = engine.seed("SecurityDocument", {
        name: "Indexed source",
        permission_id: "SEC_INDEX",
    });
    engine.seed("SecurityLink", { source_id: parent, permission_id: "SEC_INDEX" });
    const metadata = spyOn(engine.storage, "listItemTypes");

    try {
        const first = await engine.applyAML(
            `<Item type="SecurityDocument" action="edit" version="0" id="${parent.id}"><owned_by_id>SEC_EDITORS</owned_by_id></Item>`,
        );
        expect(first.isError()).toBe(false);
        const small = metadata.mock.calls.length;

        for (let index = 1; index < 100; index += 1) {
            engine.seed("SecurityLink", { source_id: parent, permission_id: "SEC_INDEX" });
        }

        metadata.mockClear();
        const second = await engine.applyAML(
            `<Item type="SecurityDocument" action="edit" version="0" id="${parent.id}"><owned_by_id>SEC_READERS</owned_by_id></Item>`,
        );
        expect(second.isError()).toBe(false);
        expect(metadata.mock.calls.length).toBeLessThanOrEqual(small + 2);
        const records = engine.storage.listItems("SecurityLink");
        expect(records).toHaveLength(100);
        expect(records.every((record) => record.properties.owned_by_id === "SEC_READERS")).toBe(
            true,
        );
        metadata.mockClear();
        const read = await engine.applyAML('<Item type="SecurityLink" action="get" select="id" />');
        expect(read.getItemCount()).toBe(100);
        expect(metadata.mock.calls.length).toBeLessThanOrEqual(3);
    } finally {
        metadata.mockRestore();
    }
});

test("an inherited relationship cannot be moved to another source implicitly", async () => {
    await using project = await securityProject(schema, fixtures);
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });
    const link = await h.getOne("SecurityLink", { name: "C editable source" });
    const other = await h.getOne("SecurityDocument", { name: "Read only" });
    const before = h.state.get("SecurityLink");
    await expect(h.update(link, { source_id: other.id })).rejects.toMatchObject({
        code: "UnsupportedSourceAccessMove",
        capability: CapabilityId.NativePermissions,
    });

    expect(h.state.get("SecurityLink")).toEqual(before);
});

test("real C# creates, edits, fetches and deletes an inherited relationship without mocks", async () => {
    const code = `
var parent = this.newItem("SecurityDocument", "get");
parent.setProperty("name", "Editable");
parent = parent.apply();
var link = this.newItem("SecurityLink", "add");
link.setProperty("source_id", parent.getID());
link.setProperty("name", "C# created");
link = link.apply();
if (link.isError()) return link;
link.setProperty("name", "C# edited");
link = link.apply("edit");
if (link.isError()) return link;
var query = this.newItem("SecurityLink", "get");
query.setID(link.getID());
var persisted = query.apply();
var removed = link.apply("delete");
if (removed.isError()) return removed;
return this.getInnovator().newResult(persisted.getProperty("name"));`;
    await using project = await securityProject(
        schema + referenceMethod("ChangeInheritedLink", code),
        fixtures,
    );
    using h = await createHarness({
        cwd: project.cwd,
        authorization: AuthorizationMode.Native,
        csharp: {},
    });
    const before = h.state.get("SecurityLink");
    const result = await h.callMethod("ChangeInheritedLink");

    expect(result.getResult()).toBe("C# edited");
    expect(h.state.get("SecurityLink")).toEqual(before);
    expect(h.executions.at(-1)?.calls[0]?.executed).toBe(true);
    expect(h.executions.at(-1)?.mocks).toHaveLength(0);
}, 60_000);

test("an authorized parent deletion removes inaccessible owned rows without granting rights to hooks", async () => {
    const code = `
var unrelated = this.newItem("SecurityDocument", "get");
unrelated.setProperty("name", "Hidden");
if (unrelated.apply().getItemCount() > 0) throw new Exception("Cascade rights leaked");
var own = this.newItem("SecurityLink", "get");
own.setID(this.getID());
if (own.apply().getItemCount() > 0) throw new Exception("Cascade rights leaked to a hook");
return this;`;
    const source =
        schema +
        referenceMethod("CheckCascadeScope", code) +
        referenceEvent("SEC_LINK", "onBeforeDelete", "CheckCascadeScope");
    const data = fixtures.replace(
        'name: "C editable source", source_id: { name: "Editable" },\n          permission_id: { name: "SEC_EDIT" }',
        'name: "C editable source", source_id: { name: "Editable" },\n          permission_id: { name: "SEC_HIDDEN" }',
    );
    await using project = await securityProject(source, data);
    using h = await createHarness({
        cwd: project.cwd,
        authorization: AuthorizationMode.Native,
        csharp: {},
    });
    const parent = await h.getOne("SecurityDocument", { name: "Editable" });
    const link = h.state.getOne("SecurityLink", { name: "C editable source" });
    expect(await h.get("SecurityLink", { id: link.id })).toEqual([]);
    const result = await h.applyAML(
        `<Item type="SecurityDocument" action="delete" id="${parent.id}" />`,
    );

    expect(result.isError()).toBe(false);
    expect(h.state.get("SecurityLink", { id: link.id })).toEqual([]);
    expect(h.state.get("SecurityDocument", { id: parent.id })).toEqual([]);
    expect(await h.get("SecurityDocument", { name: "Hidden" })).toEqual([]);
    h.reset();
    expect(h.state.get("SecurityLink", { id: link.id })).toHaveLength(1);
}, 60_000);

test("parent Delete access removes owned relationships even when Update access is absent", async () => {
    const permission = `<Item type="Permission" action="add" id="SEC_DELETE_ONLY">
        <name>Delete only</name><Relationships><Item type="Access" action="add">
            <related_id>SEC_EDITORS</related_id><can_get>1</can_get><can_delete>1</can_delete>
        </Item></Relationships>
    </Item>`;
    const data = fixtures.replaceAll(
        'permission_id: { name: "SEC_EDIT" }',
        'permission_id: { name: "Delete only" }',
    );
    await using project = await securityProject(schema + permission, data);
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });
    const parent = await h.getOne("SecurityDocument", { name: "Editable" });
    const link = await h.getOne("SecurityLink", { name: "C editable source" });
    const direct = await h.applyAML(`<Item type="SecurityLink" action="delete" id="${link.id}" />`);

    expect(direct.getErrorCode()).toBe("PermissionDenied");
    await expect(h.add("SecurityLink", { source_id: parent.id })).rejects.toThrow(
        "Permission denied",
    );
    const result = await h.applyAML(
        `<Item type="SecurityDocument" action="delete" id="${parent.id}" />`,
    );

    expect(result.isError()).toBe(false);
    expect(h.state.get("SecurityLink", { id: link.id })).toEqual([]);
    expect(h.state.get("SecurityDocument", { id: parent.id })).toEqual([]);
});

test("owned cleanup runs delete hooks without invoking a relationship's action replacement", async () => {
    const source =
        schema +
        referenceMethod("RejectDirectDelete", 'throw new Exception("Direct replacement ran");') +
        referenceEvent("SEC_LINK", "onDelete", "RejectDirectDelete") +
        referenceMethod("ObserveOwnedDelete", "return this;") +
        referenceEvent("SEC_LINK", "onBeforeDelete", "ObserveOwnedDelete") +
        referenceEvent("SEC_LINK", "onAfterDelete", "ObserveOwnedDelete");
    await using project = await securityProject(source, fixtures);
    using h = await createHarness({
        cwd: project.cwd,
        authorization: AuthorizationMode.Native,
        csharp: {},
    });
    const parent = await h.getOne("SecurityDocument", { name: "Editable" });
    const link = await h.getOne("SecurityLink", { name: "C editable source" });
    await expect(
        h.applyAML(`<Item type="SecurityLink" action="delete" id="${link.id}" />`),
    ).rejects.toThrow("Direct replacement ran");
    h.clearExecutions();
    const result = await h.applyAML(
        `<Item type="SecurityDocument" action="delete" id="${parent.id}" />`,
    );

    expect(result.isError()).toBe(false);
    expect(h.state.get("SecurityLink", { id: link.id })).toEqual([]);
    expect(h.executions.at(-1)?.changes.some((change) => change.before?.id === link.id)).toBe(true);
    const requestId = h.executions.at(-1)?.requestId;
    expect(
        h.trace
            .filter((event) => event.requestId === requestId && event.kind === "execution")
            .map((event) => event.name),
    ).toEqual(["ObserveOwnedDelete", "ObserveOwnedDelete"]);
});

test("failed owned cleanup rolls back its graph and expires its exact-call authorization", async () => {
    await using project = await securityProject(schema, fixtures);
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });
    const parent = await h.getOne("SecurityDocument", { name: "Editable" });
    const link = h.state.getOne("SecurityLink", { name: "C editable source" });
    const before = h.state.get("SecurityLink");
    using failure = h.injectFailure({
        type: "SecurityLink",
        action: ItemAction.Delete,
        at: FailurePoint.AfterCall,
        error: new Error("Reject owned cleanup"),
    });
    await expect(
        h.applyAML(`<Item type="SecurityDocument" action="delete" id="${parent.id}" />`),
    ).rejects.toThrow("Reject owned cleanup");

    expect(failure.triggered).toBe(true);
    expect(h.state.get("SecurityLink")).toEqual(before);
    expect(h.state.get("SecurityDocument", { id: parent.id })).toHaveLength(1);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
    failure[Symbol.dispose]();
    const readOnly = await h.getOne("SecurityLink", { name: "B visible link" });
    const denied = await h.applyAML(
        `<Item type="SecurityLink" action="delete" id="${readOnly.id}" />`,
    );
    expect(denied.getErrorCode()).toBe("PermissionDenied");
    expect(h.state.get("SecurityLink", { id: link.id })).toHaveLength(1);
});

test("new generations inherit changed permissions while historical relationship ACLs stay intact", async () => {
    await using project = await securityProject(schema + accessChanges, fixtures);
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });
    const parent = await h.getOne("SecurityDocument", { name: "Editable" });
    const original = h.state.getOne("SecurityLink", { name: "C editable source" });
    const updated = await h.update(parent, { permission_id: "SEC_READ" });
    const current = h.state.getOne("SecurityLink", { source_id: updated.id });

    expect(updated.id).not.toBe(parent.id);
    expect(updated.properties.config_id).toBe(parent.id);
    expect(current.properties.permission_id).toBe("SEC_READ");
    expect(h.state.getOne("SecurityLink", { id: original.id }).properties.permission_id).toBe(
        "SEC_EDIT",
    );
    expect(current.properties.source_id).toBe(updated.id);
});

test("lifecycle permissions propagate before after-promote Methods and roll back on rejection", async () => {
    const lifecycle = `<Item type="Life Cycle Map" action="add" id="SEC_SOURCE_CYCLE">
        <name>Source lifecycle</name><start_state>SEC_SOURCE_DRAFT</start_state><Relationships>
            <Item type="Life Cycle State" action="add" id="SEC_SOURCE_DRAFT"><name>Draft</name></Item>
            <Item type="Life Cycle State" action="add" id="SEC_SOURCE_READ_ONLY">
                <name>Read only</name><state_permission_id>SEC_READ</state_permission_id>
            </Item>
            <Item type="Life Cycle Transition" action="add">
                <from_state>SEC_SOURCE_DRAFT</from_state><to_state>SEC_SOURCE_READ_ONLY</to_state>
            </Item>
        </Relationships>
    </Item><Item type="ItemType Life Cycle" action="add">
        <source_id>SEC_DOCUMENT</source_id><related_id>SEC_SOURCE_CYCLE</related_id>
    </Item>`;
    await using project = await securityProject(schema + lifecycle, fixtures);
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });
    const parent = await h.getOne("SecurityDocument", { name: "Editable" });
    const before = h.state.get("SecurityLink");
    const request = `<Item type="SecurityDocument" action="promoteItem" id="${parent.id}"><state>Read only</state></Item>`;
    using failure = h.injectFailure({
        type: "SecurityDocument",
        action: ItemAction.PromoteItem,
        at: FailurePoint.AfterCall,
        error: new Error("Reject source promotion"),
    });
    await expect(h.applyAML(request)).rejects.toThrow("Reject source promotion");

    expect(h.state.get("SecurityLink")).toEqual(before);
    failure[Symbol.dispose]();
    expect((await h.applyAML(request)).isError()).toBe(false);
    expect(
        h.state.getOne("SecurityLink", { name: "C editable source" }).properties.permission_id,
    ).toBe("SEC_READ");
});

test("ACL propagation does not invoke relationship update hooks", async () => {
    const source =
        schema +
        accessChanges +
        referenceMethod("RejectInheritedHook", 'throw new Exception("Do not call child hooks");') +
        referenceEvent("SEC_LINK", "onBeforeUpdate", "RejectInheritedHook");
    await using project = await securityProject(source, fixtures);
    using h = await createHarness({
        cwd: project.cwd,
        authorization: AuthorizationMode.Native,
        csharp: {},
    });
    const parent = await h.getOne("SecurityDocument", { name: "Editable" });
    const result = await h.applyAML(
        `<Item type="SecurityDocument" action="edit" version="0" id="${parent.id}"><permission_id>SEC_READ</permission_id></Item>`,
    );

    expect(result.isError()).toBe(false);
    expect(
        h.state.getOne("SecurityLink", { name: "C editable source" }).properties.permission_id,
    ).toBe("SEC_READ");
    expect(
        h.trace.some((event) => event.kind === "method" && event.name === "RejectInheritedHook"),
    ).toBe(false);
});

test("historical relationships use their stored owner generation's ACL", async () => {
    const data = `${principalFixtures}
        SecurityDocument: [
            { name: "Historical owner", config_id: "SEC_OWNER_HISTORY", generation: 1,
              is_current: 0, permission_id: { name: "SEC_READ" } },
            { name: "Current owner", config_id: "SEC_OWNER_HISTORY", generation: 2,
              is_current: 1, permission_id: { name: "SEC_HIDDEN" } },
        ],
        SecurityLink: [
            { name: "Historical relationship", source_id: { name: "Historical owner" },
              permission_id: { name: "SEC_READ" } },
        ],
    `;
    await using project = await securityProject(schema, data);
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });

    expect(await h.get("SecurityDocument")).toHaveLength(0);
    expect(await h.get("SecurityLink", { name: "Historical relationship" })).toHaveLength(1);
});

test("cyclic source access fails closed before an Item's own ACL can grant access", async () => {
    const data = `${principalFixtures}
        SecurityCycleLink: [
            { name: "Left", source_id: { name: "Right" }, permission_id: "SEC_READ" },
            { name: "Right", source_id: { name: "Left" }, permission_id: "SEC_READ" },
        ],
    `;
    await using project = await securityProject(cycleSchema, data);
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });
    await expect(h.get("SecurityCycleLink")).rejects.toMatchObject({
        code: "SourceAccessCycle",
        capability: CapabilityId.NativePermissions,
    });
});

test("source access traversal has a bounded depth", async () => {
    const records = Array.from({ length: dataDepthMax + 1 }, (_, index) => ({
        name: `Depth ${index}`,
        source_id: { name: `Depth ${Math.min(index + 1, dataDepthMax)}` },
        permission_id: "SEC_READ",
    }));
    const data = `${principalFixtures} SecurityCycleLink: ${JSON.stringify(records)}`;
    await using project = await securityProject(cycleSchema, data);
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });
    await expect(h.get("SecurityCycleLink", { name: "Depth 0" })).rejects.toMatchObject({
        code: "ProtocolLimit",
    });
});

test("malformed source flags from storage have matching preflight and empty-query diagnostics", async () => {
    await using project = await securityProject(schema);
    let actor = "";
    using engine = createEngine({
        authorization: AuthorizationMode.Native,

        userId: () => actor,
    });
    const administrator = engine.storage
        .listItems("User")
        .find((item) => item.properties.login_name === "admin");

    if (!administrator) {
        throw new Error("The standard baseline must provide its administrator User.");
    }

    actor = administrator.id;
    await engine.loadPackages([join(project.cwd, ".harness/packages/source.xml")]);
    const metadata = engine.storage
        .listCatalogEntries("ItemType")
        .find((entry) => entry.properties.name === "SecurityLink");

    if (!metadata) {
        throw new Error("The imported source-access schema must retain its ItemType metadata.");
    }

    engine.storage.putCatalogEntry({
        ...metadata,
        properties: { ...metadata.properties, use_src_access: 2 },
    });
    const issues = inspectSecurity(engine.storage.listCatalogEntries(), AuthorizationMode.Native);
    const issue = issues.find((entry) => entry.causeCode === "InvalidSourceAccess");

    expect(issue?.code).toBe(CompatibilityIssueCode.InvalidDefinition);
    expect(issue?.severity).toBe(IssueSeverity.Error);
    expect(issue?.source?.file).toEndWith("source.xml");
    await expect(
        engine.applyAML(
            '<Item type="SecurityLink" action="get"><name>No matching records</name></Item>',
        ),
    ).rejects.toMatchObject({
        code: "InvalidSourceAccess",
        capability: CapabilityId.NativePermissions,
    });
});
