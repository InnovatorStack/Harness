import { expect, test } from "bun:test";

import {
    AuthorizationMode,
    CapabilityId,
    checkCompatibility,
    createHarness,
    fixedClock,
} from "../src/index.js";
import { Item } from "../src/items/item.js";
import type { MethodSecurity } from "../src/methods/types.js";
import { referenceMethod } from "./helpers/references.js";
import { securityFixtures, securityProject } from "./helpers/security.js";

test("membership windows affect rights at the controlled clock and restore on reset", async () => {
    const fixtures = securityFixtures.replace(
        'source_id: { name: "Test editors" }, related_id: { name: "Test contributor" }',
        'source_id: { name: "Test editors" }, related_id: { name: "Test contributor" }, from_date: "2026-01-01T00:00:00", end_date: "2026-01-01T00:00:01"',
    );
    await using project = await securityProject("", fixtures);
    using h = await createHarness({
        cwd: project.cwd,
        authorization: AuthorizationMode.Native,
        clock: fixedClock("2026-01-01T00:00:01Z"),
    });
    expect(await h.get("SecurityDocument", { name: "Editable" })).toHaveLength(1);
    h.clock.advance(1);
    expect(await h.get("SecurityDocument", { name: "Editable" })).toEqual([]);
    await expect(h.add("SecurityDocument", { name: "Denied" })).rejects.toThrow("Cannot add");
    h.reset();
    expect(await h.get("SecurityDocument", { name: "Editable" })).toHaveLength(1);
});

test("a readable reference never expands a protected target", async () => {
    const fixtures = securityFixtures.replace(
        '{ name: "Read only", permission_id: { name: "SEC_READ" } }',
        '{ name: "Read only", permission_id: { name: "SEC_READ" }, link: { name: "Hidden" } }',
    );
    await using project = await securityProject("", fixtures);
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });
    const result = await h.applyAML(
        '<Item type="SecurityDocument" action="get" select="name,link(name)"><name>Read only</name></Item>',
    );

    expect(result.getProperty("link")).toBe(
        h.state.getOne("SecurityDocument", { name: "Hidden" }).id,
    );
    expect(result.node.propertyItems.link).toBeUndefined();
});

test("unauthorized creation and deletion cannot change stored records", async () => {
    await using project = await securityProject();
    using h = await createHarness({
        cwd: project.cwd,
        authorization: AuthorizationMode.Native,
        session: { user: { login_name: "admin" } },
    });
    const before = h.state.get("SecurityDocument");
    await expect(h.add("SecurityDocument", { name: "Denied" })).rejects.toThrow("Cannot add");
    const record = h.state.getOne("SecurityDocument", { name: "Read only" });
    const result = await h.applyAML(
        `<Item type="SecurityDocument" action="delete" id="${record.id}" />`,
    );

    expect(result.getErrorCode()).toBe("PermissionDenied");
    expect(h.state.get("SecurityDocument")).toEqual(before);
});

test("native audit values come from the actor and clock and cannot be rewritten", async () => {
    await using project = await securityProject();
    using h = await createHarness({
        cwd: project.cwd,
        authorization: AuthorizationMode.Native,
        clock: fixedClock("2026-01-01T00:00:00Z"),
    });
    const record = await h.add("SecurityDocument", { name: "Created" });
    const actor = h.state.getOne("User", { login_name: "reference_owner" });
    h.clock.advance(1000);
    const updated = await h.update(record, { name: "Updated" });

    expect(updated.properties).toMatchObject({
        created_by_id: actor.id,
        created_on: "2026-01-01T00:00:00.000Z",
        modified_by_id: actor.id,
        modified_on: "2026-01-01T00:00:01.000Z",
    });
    const before = h.state.get("SecurityDocument");
    await expect(h.update(updated, { created_on: "2020-01-01T00:00:00" })).rejects.toMatchObject({
        code: "ManagedProperty",
    });
    expect(h.state.get("SecurityDocument")).toEqual(before);
});

test("executor security ports expire after the Method returns and grants stay local to a world", async () => {
    await using project = await securityProject(referenceMethod("CustomGrant", "unused"));
    let retained: MethodSecurity | undefined;
    using first = await createHarness({
        cwd: project.cwd,
        authorization: AuthorizationMode.Native,
        executors: [
            () => ({
                language: "C#",

                async execute(_method, _context, ports) {
                    retained = ports.security;

                    if (!retained) {
                        throw new Error("The platform must supply its security port.");
                    }

                    retained.grantIdentity("SEC_PUBLISHERS");

                    return new Item({ items: [], result: retained.getIdentities().join(",") });
                },
            }),
        ],
    });
    using second = await createHarness({
        cwd: project.cwd,
        authorization: AuthorizationMode.Native,
    });
    const result = await first.callMethod("CustomGrant");
    expect(result.getResult().split(",")).toContain("SEC_PUBLISHERS");
    expect(() => retained?.getIdentities()).toThrow();
    second.reset();
    const record = await first.getOne("SecurityDocument", { name: "Publish controlled" });
    await expect(first.update(record, { name: "Denied" })).rejects.toThrow("Permission denied");
    const other = await second.getOne("SecurityDocument", { name: "Publish controlled" });
    await expect(second.update(other, { name: "Denied" })).rejects.toThrow("Permission denied");
});

test("source-inherited access has matching preflight and runtime capability diagnostics", async () => {
    const source =
        '<Item type="ItemType" action="edit" id="SEC_DOCUMENT"><use_src_access>1</use_src_access></Item>';
    await using project = await securityProject(source);
    const options = { cwd: project.cwd, authorization: AuthorizationMode.Native };
    const report = await checkCompatibility(options);

    expect(
        report.issues.find((issue) => issue.causeCode === "UnsupportedSourceAccess")?.capability,
    ).toBe(CapabilityId.NativePermissions);
    using h = await createHarness(options);
    await expect(h.get("SecurityDocument")).rejects.toMatchObject({
        code: "UnsupportedSourceAccess",
        capability: CapabilityId.NativePermissions,
    });
});

test("transition roles evaluate Owner against the actual stored record", async () => {
    const lifecycle = `<Item type="Life Cycle Map" action="add" id="SEC_CYCLE"><name>Secure cycle</name><start_state>SEC_DRAFT</start_state><Relationships>
        <Item type="Life Cycle State" action="add" id="SEC_DRAFT"><name>Draft</name></Item>
        <Item type="Life Cycle State" action="add" id="SEC_RELEASED"><name>Released</name></Item>
        <Item type="Life Cycle Transition" action="add"><from_state>SEC_DRAFT</from_state><to_state>SEC_RELEASED</to_state><role>538B300BB2A347F396C436E9EEE1976C</role></Item>
        </Relationships></Item><Item type="ItemType Life Cycle" action="add"><source_id>SEC_DOCUMENT</source_id><related_id>SEC_CYCLE</related_id></Item>`;
    const fixtures = securityFixtures.replace(
        '{ name: "Editable", permission_id: { name: "SEC_EDIT" } }',
        '{ name: "Editable", permission_id: { name: "SEC_EDIT" }, owned_by_id: { name: "Test readers" } }',
    );
    await using project = await securityProject(lifecycle, fixtures);
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });
    const owned = await h.getOne("SecurityDocument", { name: "Editable" });
    const promoted = await h.applyAML(
        `<Item type="SecurityDocument" action="promoteItem" id="${owned.id}"><state>Released</state></Item>`,
    );

    expect(promoted.node.properties.state).toBe("Released");
    const other = await h.add("SecurityDocument", { name: "Other owner" });
    const before = h.state.get("SecurityDocument");
    const denied = await h.applyAML(
        `<Item type="SecurityDocument" action="promoteItem" id="${other.id}"><state>Released</state></Item>`,
    );

    expect(denied.getErrorCode()).toBe("PermissionDenied");
    expect(h.state.get("SecurityDocument")).toEqual(before);
});

test("membership cycles terminate without adding unrelated identities", async () => {
    const fixtures = securityFixtures.replace(
        "Member: [",
        `Member: [
        { created_on: "2026-01-01T00:00:00", created_by_id: { login_name: "reference_owner" },
          source_id: { name: "Test contributor" }, related_id: { name: "Test readers" } },`,
    );
    await using project = await securityProject("", fixtures);
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });

    expect(await h.get("SecurityDocument", { name: "Editable" })).toHaveLength(1);
    const record = await h.getOne("SecurityDocument", { name: "Publish controlled" });
    await expect(h.update(record, { name: "Denied" })).rejects.toThrow("Permission denied");
});
