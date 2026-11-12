import { expect, test } from "bun:test";
import { join } from "node:path";

import { createEngine } from "../src/engine.js";
import {
    AuthorizationMode,
    CapabilityId,
    checkCompatibility,
    createHarness,
    ExecutionOutcome,
    FailurePoint,
    fixedClock,
    ItemAction,
} from "../src/index.js";
import { referenceMethod } from "./helpers/references.js";
import { principalFixtures, securityProject } from "./helpers/security.js";

function permission(name: string, role: string, rights: readonly string[]): string {
    const flags = rights.map((right) => `<can_${right}>1</can_${right}>`).join("\n");

    return `
<Item type="Permission" action="add">
    <name>${name}</name>
    <Relationships>
        <Item type="Access" action="add">
            <related_id><Item type="Identity" action="get"><name>${role}</name></Item></related_id>
            ${flags}
        </Item>
    </Relationships>
</Item>
<Item type="Allowed Permission" action="add">
    <source_id>SEC_DOCUMENT</source_id>
    <related_id><Item type="Permission" action="get"><name>${name}</name></Item></related_id>
</Item>`;
}

const schema = `
<Item type="ItemType" action="edit" id="SEC_DOCUMENT">
    <Relationships>
        <Item type="Property" action="add">
            <name>team_id</name><data_type>item</data_type>
            <data_source><Item type="ItemType" action="get"><name>Team</name></Item></data_source>
        </Item>
    </Relationships>
</Item>
<Item type="Identity" action="add"><name>Team reviewer</name><classification>Team</classification></Item>
${permission("Team managers", "Team Manager", ["get", "update", "delete", "change_access"])}
${permission("Team members", "Team Member", ["get", "update"])}
${permission("Team guests", "Team Guest", ["get"])}
${permission("Whole team", "Team", ["get"])}
${permission("Team reviewers", "Team reviewer", ["get", "update"])}
`;

const audit = 'created_on: "2026-01-01T00:00:00", created_by_id: { login_name: "reference_owner" }';
const memberships = `${principalFixtures}
    Team: [
        { name: "Alpha", ${audit}, permission_id: { name: "SEC_READ" } },
        { name: "Beta", ${audit}, permission_id: { name: "SEC_READ" } },
        { name: "Gamma", ${audit}, permission_id: { name: "SEC_READ" } },
        { name: "Delta", ${audit}, permission_id: { name: "SEC_READ" } },
        { name: "Custom", ${audit}, permission_id: { name: "SEC_READ" } },
        { name: "Empty", ${audit}, permission_id: { name: "SEC_READ" } },
    ],
    "Team Identity": [
        { source_id: { name: "Alpha" }, related_id: { name: "Test editors" },
          team_role: { name: "Team Manager" }, ${audit}, permission_id: { name: "SEC_EDIT" } },
        { source_id: { name: "Alpha" }, related_id: { name: "Test publishers" },
          team_role: { name: "Team Member" }, ${audit}, permission_id: { name: "SEC_EDIT" } },
        { source_id: { name: "Beta" }, related_id: { name: "Test editors" },
          team_role: { name: "Team Member" }, ${audit}, permission_id: { name: "SEC_EDIT" } },
        { source_id: { name: "Gamma" }, related_id: { name: "Test contributor" },
          team_role: { name: "Team Guest" }, ${audit}, permission_id: { name: "SEC_EDIT" } },
        { source_id: { name: "Delta" }, related_id: { name: "Test editors" },
          ${audit}, permission_id: { name: "SEC_EDIT" } },
        { source_id: { name: "Custom" }, related_id: { name: "Test editors" },
          team_role: { name: "Team reviewer" }, ${audit}, permission_id: { name: "SEC_EDIT" } },
    ],
`;

const documents = `SecurityDocument: [
    { name: "A denied manager", team_id: { name: "Beta" }, permission_id: { name: "Team managers" } },
    { name: "B managed", team_id: { name: "Alpha" }, permission_id: { name: "Team managers" } },
    { name: "C beta member", team_id: { name: "Beta" }, permission_id: { name: "Team members" } },
    { name: "D guest", team_id: { name: "Gamma" }, permission_id: { name: "Team guests" } },
    { name: "E default role", team_id: { name: "Delta" }, permission_id: { name: "Whole team" } },
    { name: "F custom role", team_id: { name: "Custom" }, permission_id: { name: "Team reviewers" } },
    { name: "G whole team manager", team_id: { name: "Alpha" }, permission_id: { name: "Whole team" } },
    { name: "H whole team member", team_id: { name: "Beta" }, permission_id: { name: "Whole team" } },
    { name: "I whole team guest", team_id: { name: "Gamma" }, permission_id: { name: "Whole team" } },
    { name: "J manager is not member", team_id: { name: "Alpha" }, permission_id: { name: "Team members" } },
    { name: "K missing team", permission_id: { name: "Team managers" } },
    { name: "L different custom team", team_id: { name: "Alpha" }, permission_id: { name: "Team reviewers" } },
    { name: "M empty team", team_id: { name: "Empty" }, permission_id: { name: "Whole team" } },
],`;
const fixtures = memberships + documents;

test("team roles resolve per record from alias and nested group memberships before paging", async () => {
    await using project = await securityProject(schema, fixtures);
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });
    const before = h.state.get("SecurityDocument");
    const result = await h.applyAML(
        '<Item type="SecurityDocument" action="get" orderBy="name" pagesize="1" />',
    );

    expect(result.getProperty("name")).toBe("B managed");
    expect(result.payload.messages).toContainEqual({ name: "itemmax", value: "8" });
    const names = (await h.get("SecurityDocument"))
        .map((item) => String(item.properties.name))
        .sort((left, right) => left.localeCompare(right));
    expect(names).toEqual([
        "B managed",
        "C beta member",
        "D guest",
        "E default role",
        "F custom role",
        "G whole team manager",
        "H whole team member",
        "I whole team guest",
    ]);
    expect(h.state.get("SecurityDocument")).toEqual(before);
});

test("team ACLs authorize updates, deletion and access changes without granting other team roles", async () => {
    await using project = await securityProject(schema, fixtures);
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });
    const member = await h.getOne("SecurityDocument", { name: "C beta member" });
    const updated = await h.update(member, { name: "Saved by member" });
    expect(updated.id).not.toBe(member.id);
    expect(updated.properties.config_id).toBe(member.id);
    expect((await h.getOne("SecurityDocument", { id: updated.id })).properties.name).toBe(
        "Saved by member",
    );
    const guest = await h.getOne("SecurityDocument", { name: "D guest" });
    const before = h.state.get("SecurityDocument");
    await expect(h.update(guest, { name: "Forbidden" })).rejects.toThrow("Permission denied");
    expect(h.state.get("SecurityDocument")).toEqual(before);

    const manager = await h.getOne("SecurityDocument", { name: "B managed" });
    const permission = h.state.getOne("Permission", { name: "SEC_READ" });
    const changed = await h.update(manager, { permission_id: permission.id });
    expect(changed.properties.permission_id).toBe(permission.id);
    const denied = await h.applyAML(
        `<Item type="SecurityDocument" action="delete" id="${updated.id}" />`,
    );
    expect(denied.getErrorCode()).toBe("PermissionDenied");
    await expect(h.update(updated, { permission_id: permission.id })).rejects.toThrow(
        "Permission denied",
    );
    const reviewer = await h.getOne("SecurityDocument", { name: "F custom role" });
    expect((await h.update(reviewer, { name: "Reviewed" })).properties.name).toBe("Reviewed");
    const team = await h.getOne("Team", { name: "Alpha" });
    const managers = h.state.getOne("Permission", { name: "Team managers" });
    const removable = await h.add("SecurityDocument", {
        name: "Can delete",
        team_id: team.id,
        permission_id: managers.id,
    });
    const deleted = await h.applyAML(
        `<Item type="SecurityDocument" action="delete" id="${removable.id}" />`,
    );
    expect(deleted.isError()).toBe(false);
    expect(h.state.get("SecurityDocument", { config_id: removable.id })).toHaveLength(0);
});

test("standard team roles retain their native identity when their display names change", async () => {
    const renamed = `<Item type="Identity" action="edit" id="60EBF9D1BB584921A73FA2F8D74DAF80">
        <name>Renamed manager</name></Item>`;
    const source =
        renamed + schema.replaceAll("<name>Team Manager</name>", "<name>Renamed manager</name>");
    const data = fixtures.replaceAll(
        'team_role: { name: "Team Manager" }',
        'team_role: { name: "Renamed manager" }',
    );
    await using project = await securityProject(source, data);
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });

    expect(await h.get("SecurityDocument", { name: "B managed" })).toHaveLength(1);
    expect(await h.get("SecurityDocument", { name: "A denied manager" })).toHaveLength(0);
});

test("a named custom role requires Team classification to participate in dynamic access", async () => {
    const source = schema.replace("<classification>Team</classification>", "<classification />");
    await using project = await securityProject(source, fixtures);
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });

    expect(await h.get("SecurityDocument", { name: "F custom role" })).toHaveLength(0);
    expect(await h.get("SecurityDocument", { name: "B managed" })).toHaveLength(1);
});

test("malformed team_id data cannot become membership or an ordinary permission denial", async () => {
    const source = schema.replace(
        "<name>team_id</name><data_type>item</data_type>",
        "<name>team_id</name><data_type>integer</data_type>",
    );
    const data = `${memberships} SecurityDocument: [
        { name: "Invalid team", team_id: 1, permission_id: { name: "Whole team" } },
    ],`;
    await using project = await securityProject(source, data);
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });
    await expect(h.get("SecurityDocument")).rejects.toMatchObject({
        code: "InvalidTeamReference",
        capability: CapabilityId.NativePermissions,
    });

    expect(h.state.getOne("SecurityDocument", { name: "Invalid team" }).properties.team_id).toBe(1);
});

test("source-inherited relationship permissions use the source Team and protect related Items", async () => {
    const relationship = `<Item type="ItemType" action="add" id="TEAM_LINK">
        <name>TeamLink</name><is_relationship>1</is_relationship><use_src_access>1</use_src_access>
        <Relationships>
            <Item type="Property" action="add">
                <name>permission_id</name><data_type>item</data_type>
                <data_source><Item type="ItemType" action="get"><name>Permission</name></Item></data_source>
            </Item>
            <Item type="Property" action="add">
                <name>team_id</name><data_type>item</data_type>
                <data_source><Item type="ItemType" action="get"><name>Team</name></Item></data_source>
            </Item>
        </Relationships>
    </Item>
    <Item type="RelationshipType" action="add">
        <name>TeamLink</name><relationship_id>TEAM_LINK</relationship_id>
        <source_id>SEC_DOCUMENT</source_id><related_id>SEC_DOCUMENT</related_id>
    </Item>`;
    const data = `${fixtures} TeamLink: [{
        source_id: { name: "B managed" }, related_id: { name: "A denied manager" },
        team_id: { name: "Beta" }, permission_id: { name: "SEC_HIDDEN" },
    }],`;
    await using project = await securityProject(schema + relationship, data);
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });
    const result = await h.applyAML(
        '<Item type="TeamLink" action="get" select="source_id(name),related_id(name),team_id" />',
    );

    expect(result.getItemCount()).toBe(1);
    expect(result.node.propertyItems.source_id?.properties.name).toBe("B managed");
    expect(result.node.propertyItems.related_id).toBeUndefined();
    expect(result.getProperty("team_id")).toBe(h.state.getOne("Team", { name: "Beta" }).id);
});

test("membership changes take effect in the next action and remain isolated across worlds and reset", async () => {
    await using project = await securityProject(schema, fixtures);
    const options = { cwd: project.cwd, authorization: AuthorizationMode.Native };
    using first = await createHarness(options);
    using second = await createHarness(options);
    const team = await first.getOne("Team", { name: "Alpha" });
    const manager = first.state.getOne("Identity", { name: "Team Manager" });
    const guest = first.state.getOne("Identity", { name: "Team Guest" });
    const membership = await first.getOne("Team Identity", {
        source_id: team.id,
        team_role: manager.id,
    });
    await first.update(membership, { team_role: guest.id });

    expect(await first.get("SecurityDocument", { name: "B managed" })).toHaveLength(0);
    expect(await first.get("SecurityDocument", { name: "G whole team manager" })).toHaveLength(1);
    expect(await second.get("SecurityDocument", { name: "B managed" })).toHaveLength(1);
    first.reset();
    expect(await first.get("SecurityDocument", { name: "B managed" })).toHaveLength(1);
});

test("a rejected team membership change rolls back its stored role and subsequent permissions", async () => {
    await using project = await securityProject(schema, fixtures);
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });
    const team = await h.getOne("Team", { name: "Alpha" });
    const manager = h.state.getOne("Identity", { name: "Team Manager" });
    const guest = h.state.getOne("Identity", { name: "Team Guest" });
    const membership = await h.getOne("Team Identity", {
        source_id: team.id,
        team_role: manager.id,
    });
    using _failure = h.injectFailure({
        type: "Team Identity",
        action: ItemAction.Edit,
        at: FailurePoint.AfterCall,
        error: new Error("Reject membership change"),
    });
    await expect(h.update(membership, { team_role: guest.id })).rejects.toThrow(
        "Reject membership change",
    );
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
    expect(h.state.getOne("Team Identity", { id: membership.id }).properties.team_role).toBe(
        manager.id,
    );
    expect(await h.get("SecurityDocument", { name: "B managed" })).toHaveLength(1);
});

test("team membership through a group respects its effective dates and controlled clock reset", async () => {
    const data = fixtures.replace(
        'source_id: { name: "Test editors" }, related_id: { name: "Test contributor" }',
        'source_id: { name: "Test editors" }, related_id: { name: "Test contributor" }, end_date: "2026-01-01T00:00:01"',
    );
    await using project = await securityProject(schema, data);
    using h = await createHarness({
        cwd: project.cwd,
        authorization: AuthorizationMode.Native,
        clock: fixedClock("2026-01-01T00:00:01Z"),
    });

    expect(await h.get("SecurityDocument", { name: "B managed" })).toHaveLength(1);
    h.clock.advance(1);
    expect(await h.get("SecurityDocument", { name: "B managed" })).toHaveLength(0);
    expect(await h.get("SecurityDocument", { name: "D guest" })).toHaveLength(1);
    h.reset();
    expect(await h.get("SecurityDocument", { name: "B managed" })).toHaveLength(1);
});

const lifecycle = `<Item type="Life Cycle Map" action="add" id="TEAM_CYCLE">
    <name>Team review</name><start_state>TEAM_DRAFT</start_state>
    <Relationships>
        <Item type="Life Cycle State" action="add" id="TEAM_DRAFT"><name>Draft</name></Item>
        <Item type="Life Cycle State" action="add" id="TEAM_APPROVED"><name>Approved</name></Item>
        <Item type="Life Cycle Transition" action="add">
            <from_state>TEAM_DRAFT</from_state><to_state>TEAM_APPROVED</to_state>
            <role><Item type="Identity" action="get"><name>Team Manager</name></Item></role>
        </Item>
    </Relationships>
</Item>
<Item type="ItemType Life Cycle" action="add">
    <source_id>SEC_DOCUMENT</source_id><related_id>TEAM_CYCLE</related_id>
</Item>`;

test("transition roles use the promoted Item's team independently of its update permission", async () => {
    const data = `${memberships} SecurityDocument: [
        { name: "Can promote", team_id: { name: "Alpha" }, permission_id: { name: "SEC_EDIT" } },
        { name: "Cannot promote", team_id: { name: "Beta" }, permission_id: { name: "SEC_EDIT" } },
    ],`;
    await using project = await securityProject(schema + lifecycle, data);
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });
    const approved = await h.getOne("SecurityDocument", { name: "Can promote" });
    const allowed = await h.applyAML(
        `<Item type="SecurityDocument" action="promoteItem" id="${approved.id}"><state>Approved</state></Item>`,
    );
    expect(allowed.getProperty("state")).toBe("Approved");
    const other = await h.getOne("SecurityDocument", { name: "Cannot promote" });
    const before = h.state.get("SecurityDocument");
    const denied = await h.applyAML(
        `<Item type="SecurityDocument" action="promoteItem" id="${other.id}"><state>Approved</state></Item>`,
    );

    expect(denied.getErrorCode()).toBe("PermissionDenied");
    expect(h.state.get("SecurityDocument")).toEqual(before);
});

const managedSource = `
var inn = this.getInnovator();
var all = inn.newItem("SecurityDocument", "get").apply();
var role = Aras.Server.Security.Identity.GetByName("Team Manager");
if (CCO.Permissions.IdentityListHasId(CCO.Permissions.IdentitiesList, role.Id))
{
    throw new Exception("A record-specific role leaked into the global session");
}

var publishers = Aras.Server.Security.Identity.GetByName("Test publishers");
using (CCO.Permissions.GrantIdentity(publishers))
{
    var query = inn.newItem("SecurityDocument", "get");
    query.setProperty("name", "J manager is not member");
    if (query.apply().getItemCount() != 1)
    {
        throw new Exception("The scoped identity must participate in its assigned Team role");
    }
}
return all;`;

test("real C# uses team permissions and scoped grants without adding roles to the global session", async () => {
    const method = referenceMethod("ReadTeamDocuments", managedSource);
    await using project = await securityProject(schema + method, fixtures);
    using h = await createHarness({
        cwd: project.cwd,
        authorization: AuthorizationMode.Native,
        csharp: {},
    });
    const result = await h.callMethod("ReadTeamDocuments");

    expect(result.isError()).toBe(false);
    expect(result.getItemCount()).toBe(8);
    expect(h.executions.at(-1)?.calls[0]?.executed).toBe(true);
    expect(h.executions.at(-1)?.mocks).toHaveLength(0);
    expect(await h.get("SecurityDocument", { name: "J manager is not member" })).toHaveLength(0);
}, 60_000);

test("supported standard and custom team ACLs no longer produce an unsupported compatibility issue", async () => {
    await using project = await securityProject(schema, fixtures);
    const report = await checkCompatibility({
        cwd: project.cwd,
        authorization: AuthorizationMode.Native,
    });

    expect(report.packages.canImport).toBe(true);
    expect(
        report.issues.filter((issue) => issue.causeCode === "UnsupportedTeamPermissions"),
    ).toEqual([]);
});

test("a missing Team fails closed with the original referring ItemType's source", async () => {
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
        throw new Error("The standard baseline must supply its administrator User.");
    }

    actor = administrator.id;
    const imported = await engine.loadPackages([join(project.cwd, ".harness/packages/source.xml")]);
    const team = engine.seed("Team", {
        name: "Removed team",
        created_on: "2026-01-01T00:00:00",
        created_by_id: actor,
        permission_id: "SEC_READ",
    });
    const permission = engine.storage
        .listItems("Permission")
        .find((item) => item.properties.name === "Whole team");

    if (!permission) {
        throw new Error("The original package must provide the whole-team Permission.");
    }

    engine.seed("SecurityDocument", {
        name: "Orphan",
        team_id: team,
        permission_id: permission.id,
    });
    engine.storage.deleteItem(team.type, team.id);
    await expect(
        engine.applyAML('<Item type="SecurityDocument" action="get" />'),
    ).rejects.toMatchObject({
        code: "MissingTeam",
        capability: CapabilityId.NativePermissions,
        source: { file: imported.documents[0]?.path },
    });
});
