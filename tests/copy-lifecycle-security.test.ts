import { expect, test } from "bun:test";

import {
    AuthorizationMode,
    createHarness,
    ExecutionOutcome,
    FailurePoint,
    fixedClock,
    ItemAction,
    seededIds,
} from "../src/index.js";
import { securityFixtures, securityProject } from "./helpers/security.js";

const schema = `
<Item type="ItemType" action="add" id="COPY_SECURITY_LINK">
    <name>CopySecurityLink</name><is_relationship>1</is_relationship><use_src_access>1</use_src_access>
</Item>
<Item type="RelationshipType" action="add"><name>CopySecurityLink</name>
    <relationship_id>COPY_SECURITY_LINK</relationship_id><source_id>SEC_DOCUMENT</source_id>
</Item>
<Item type="ItemType" action="add" id="COPY_SECURITY_DETAIL">
    <name>CopySecurityDetail</name><is_relationship>1</is_relationship><use_src_access>1</use_src_access>
</Item>
<Item type="RelationshipType" action="add"><name>CopySecurityDetail</name>
    <relationship_id>COPY_SECURITY_DETAIL</relationship_id><source_id>COPY_SECURITY_LINK</source_id>
</Item>
<Item type="Life Cycle Map" action="add" id="COPY_SECURITY_CYCLE">
    <name>Security copy lifecycle</name><start_state>COPY_SECURITY_DRAFT</start_state><Relationships>
        <Item type="Life Cycle State" action="add" id="COPY_SECURITY_DRAFT">
            <name>Draft</name><state_permission_id>SEC_READ</state_permission_id>
        </Item>
        <Item type="Life Cycle State" action="add" id="COPY_SECURITY_WORKING">
            <name>Working</name><state_permission_id>SEC_EDIT</state_permission_id>
        </Item>
    </Relationships>
</Item>
<Item type="ItemType Life Cycle" action="add">
    <source_id>COPY_SECURITY_LINK</source_id><related_id>COPY_SECURITY_CYCLE</related_id>
</Item>`;

const fixtures = `${securityFixtures}
    CopySecurityLink: [{ source_id: { name: "Editable" }, state: "Working" }],
    CopySecurityDetail: [{ source_id: { state: "Working" }, permission_id: "SEC_EDIT" }],`;

test("copied state permissions override inherited ACLs and reach nested records before returning", async () => {
    await using project = await securityProject(schema, fixtures);
    using h = await createHarness({
        cwd: project.cwd,
        authorization: AuthorizationMode.Native,
        clock: fixedClock("2026-01-01T00:00:00Z"),
    });
    const source = await h.getOne("SecurityDocument", { name: "Editable" });
    const link = h.state.getOne("CopySecurityLink", { source_id: source.id });
    const detail = h.state.getOne("CopySecurityDetail", { source_id: link.id });
    const actor = h.state.getOne("User", { login_name: "reference_owner" });
    h.clock.advance(1000);
    const saved = await h.update(source, { name: "Saved" });
    const copied = await h.getOne("CopySecurityLink", { source_id: saved.id });
    const nested = await h.getOne("CopySecurityDetail", { source_id: copied.id });

    expect(copied.properties).toMatchObject({
        state: "Draft",
        current_state: "COPY_SECURITY_DRAFT",
        permission_id: "SEC_READ",
        modified_by_id: actor.id,
        modified_on: "2026-01-01T00:00:01.000Z",
    });
    expect(nested.properties.permission_id).toBe("SEC_READ");
    expect(h.state.getOne("CopySecurityLink", { id: link.id })).toEqual({
        ...link,
        properties: { ...link.properties, behavior: "hard_fixed" },
    });
    expect(h.state.getOne("CopySecurityDetail", { id: detail.id })).toEqual({
        ...detail,
        properties: { ...detail.properties, behavior: "hard_fixed" },
    });
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.Committed);
});

test("copy lifecycle writes share rollback and reset without leaking IDs, clocks or ACLs between worlds", async () => {
    await using project = await securityProject(schema, fixtures);
    const options = {
        cwd: project.cwd,
        authorization: AuthorizationMode.Native,
        clock: fixedClock("2026-01-01T00:00:00Z"),
        ids: seededIds("copy-security-reset"),
    };
    using h = await createHarness(options);
    using other = await createHarness(options);
    const parent = await h.getOne("SecurityDocument", { name: "Editable" });
    const before = h.state.get("SecurityDocument");
    const links = h.state.get("CopySecurityLink");
    const details = h.state.get("CopySecurityDetail");
    using failure = h.injectFailure({
        type: "SecurityDocument",
        action: ItemAction.Edit,
        at: FailurePoint.AfterCall,
        error: new Error("Reject copied permissions"),
    });

    await expect(h.update(parent, { name: "Rejected" })).rejects.toThrow(
        "Reject copied permissions",
    );
    expect(h.state.get("SecurityDocument")).toEqual(before);
    expect(h.state.get("CopySecurityLink")).toEqual(links);
    expect(h.state.get("CopySecurityDetail")).toEqual(details);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
    failure[Symbol.dispose]();
    h.reset();
    h.clock.advance(1000);
    const saved = await h.update(await h.getOne("SecurityDocument", { name: "Editable" }), {
        name: "Saved",
    });
    const copied = h.state.getOne("CopySecurityLink", { source_id: saved.id });
    h.reset();
    expect(h.clock.now().toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(h.state.get("CopySecurityLink")).toEqual(links);
    const repeated = await h.update(await h.getOne("SecurityDocument", { name: "Editable" }), {
        name: "Saved again",
    });

    expect(repeated.id).toBe(saved.id);
    expect(h.state.getOne("CopySecurityLink", { source_id: repeated.id }).id).toBe(copied.id);
    expect(other.state.get("SecurityDocument")).toEqual(before);
    expect(other.state.get("CopySecurityLink")).toEqual(links);
    expect(other.state.get("CopySecurityDetail")).toEqual(details);
    expect(other.clock.now().toISOString()).toBe("2026-01-01T00:00:00.000Z");
});
