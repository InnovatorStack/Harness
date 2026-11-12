import { expect, test } from "bun:test";
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
          related_id: { name: "Read only" }, permission_id: { name: "SEC_READ" } },
        { name: "B visible link", source_id: { name: "Read only" },
          related_id: { name: "Hidden" }, permission_id: { name: "SEC_HIDDEN" } },
        { name: "C editable source", source_id: { name: "Editable" },
          permission_id: { name: "SEC_HIDDEN" } },
    ],
    SecurityNestedLink: [
        { name: "Nested", source_id: { name: "B visible link" },
          permission_id: { name: "SEC_HIDDEN" } },
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

test("relationship reads use source ACLs before paging and leave stored permission values intact", async () => {
    await using project = await securityProject(schema, fixtures);
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });
    const before = h.state.get("SecurityLink");
    const result = await h.applyAML(
        '<Item type="SecurityLink" action="get" orderBy="name" pagesize="1" />',
    );

    expect(result.getProperty("name")).toBe("B visible link");
    expect(result.getProperty("permission_id")).toBe("SEC_HIDDEN");
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

    expect(nested.properties.permission_id).toBe("SEC_HIDDEN");
    expect(result.getProperty("related_id")).toBe(
        h.state.getOne("SecurityDocument", { name: "Hidden" }).id,
    );
    expect(result.node.propertyItems.related_id).toBeUndefined();
});

test.each([
    { sourceCreator: "reference_owner", linkCreator: "admin", readable: true },
    { sourceCreator: "admin", linkCreator: "reference_owner", readable: false },
])("Creator access is evaluated against the permission source: %s", async (scenario) => {
    const data = fixtures
        .replace(
            '{ name: "Read only", permission_id: { name: "SEC_READ" } }',
            `{ name: "Read only", permission_id: { name: "SEC_CREATOR" },
                created_by_id: { login_name: "${scenario.sourceCreator}" } }`,
        )
        .replace(
            'name: "B visible link",',
            `name: "B visible link", created_by_id: { login_name: "${scenario.linkCreator}" },`,
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

test("direct source-inherited mutations retain explicit diagnostics and transaction rollback", async () => {
    await using project = await securityProject(schema, fixtures);
    const options = { cwd: project.cwd, authorization: AuthorizationMode.Native };
    using h = await createHarness(options);
    const link = await h.getOne("SecurityLink", { name: "C editable source" });
    const before = h.state.get("SecurityLink");
    await expect(h.update(link, { name: "Must not save" })).rejects.toMatchObject({
        code: "UnsupportedSourceAccess",
        capability: CapabilityId.NativePermissions,
    });

    expect(h.state.get("SecurityLink")).toEqual(before);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
    const report = await checkCompatibility(options);
    expect(
        report.issues.find((issue) => issue.causeCode === "UnsupportedSourceAccess")?.message,
    ).toContain("mutations remain unavailable");
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
        <Item type="SecurityDocument" action="edit" version="0" id="${source.id}">
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
    using failure = h.injectFailure({
        type: "SecurityDocument",
        action: ItemAction.Edit,
        at: FailurePoint.AfterCall,
        error: new Error("Reject the permission change"),
    });
    await expect(
        h.applyAML(`<Item type="SecurityDocument" action="edit" version="0" id="${source.id}">
            <permission_id>${hidden.id}</permission_id></Item>`),
    ).rejects.toThrow("Reject the permission change");

    expect(failure.triggered).toBe(true);
    expect(h.state.get("SecurityDocument")).toEqual(before);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
    expect(await h.get("SecurityLink", { name: "C editable source" })).toHaveLength(1);
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
              permission_id: { name: "SEC_HIDDEN" } },
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
