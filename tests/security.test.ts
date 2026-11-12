import { expect, test } from "bun:test";

import { AuthorizationMode, createHarness, ExecutionOutcome } from "../src/index.js";
import { referenceMethod } from "./helpers/references.js";
import { principalFixtures, securityProject } from "./helpers/security.js";

test("native reads filter hidden records before paging and preserve raw-state inspection", async () => {
    await using project = await securityProject();
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });
    const page = await h.applyAML(
        '<Item type="SecurityDocument" action="get" orderBy="name" pagesize="2" />',
    );

    expect(page.payload.items.map((item) => item.properties.name)).toEqual([
        "Editable",
        "Publish controlled",
    ]);
    expect(page.payload.messages).toContainEqual({ name: "itemmax", value: "3" });
    expect(h.state.get("SecurityDocument")).toHaveLength(4);
    expect(await h.get("SecurityDocument", { name: "Hidden" })).toEqual([]);
});

test("native create, update and delete follow imported Can Add, default Permission and Access rows", async () => {
    await using project = await securityProject();
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });
    const created = await h.add("SecurityDocument", { name: "Created" });
    const edited = await h.update(created, { name: "Edited" });

    expect(created.properties.permission_id).toBe("SEC_EDIT");
    expect(edited.properties).toMatchObject({
        name: "Edited",
        generation: 2,
        config_id: created.id,
    });
    const deleted = await h.applyAML(
        `<Item type="SecurityDocument" action="delete" id="${edited.id}" />`,
    );
    expect(deleted.isError()).toBe(false);
    expect(h.state.get("SecurityDocument", { config_id: created.id })).toHaveLength(0);
});

test("an update denial rolls back locks and leaves every generation unchanged", async () => {
    await using project = await securityProject();
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });
    const record = await h.getOne("SecurityDocument", { name: "Read only" });
    const before = h.state.get("SecurityDocument");
    await expect(h.update(record, { name: "Rejected" })).rejects.toThrow("Permission denied");

    expect(h.state.get("SecurityDocument")).toEqual(before);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
});

test("changing access requires its own right even when ordinary updates are permitted", async () => {
    await using project = await securityProject();
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });
    const record = await h.getOne("SecurityDocument", { name: "Editable" });
    const before = h.state.get("SecurityDocument");
    await expect(h.update(record, { permission_id: "SEC_READ" })).rejects.toThrow(
        "can_change_access",
    );

    expect(h.state.get("SecurityDocument")).toEqual(before);
});

test("Owner, Manager and Creator resolve from each record instead of permanent session membership", async () => {
    const fixtures = `${principalFixtures}
        SecurityDocument: [
            { name: "Owned", permission_id: { name: "SEC_OWNER" }, owned_by_id: { name: "Test readers" } },
            { name: "Managed", permission_id: { name: "SEC_MANAGER" }, managed_by_id: { name: "Test editors" } },
            { name: "Created", permission_id: { name: "SEC_CREATOR" }, created_by_id: { login_name: "reference_owner" } },
            { name: "Other creator", permission_id: { name: "SEC_CREATOR" }, created_by_id: { login_name: "admin" } },
        ]`;
    await using project = await securityProject("", fixtures);
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });

    expect(
        (await h.get("SecurityDocument"))
            .map((record) => record.properties.name)
            .sort((left, right) => String(left).localeCompare(String(right))),
    ).toEqual(["Created", "Managed", "Owned"]);
});

test("native Method execution restrictions apply to mocked and unmocked calls", async () => {
    const source = referenceMethod("PublishOnly", "return this;").replace(
        "</method_type>",
        "</method_type><execution_allowed_to>SEC_PUBLISHERS</execution_allowed_to>",
    );
    await using project = await securityProject(source);
    using h = await createHarness({
        cwd: project.cwd,
        authorization: AuthorizationMode.Native,
        mocks: [{ method: "PublishOnly", response: { text: "Must not run" } }],
    });
    const result = await h.callMethod("PublishOnly");
    expect(result.getErrorCode()).toBe("PermissionDenied");

    expect(h.executions.at(-1)?.mocks).toHaveLength(0);
});
