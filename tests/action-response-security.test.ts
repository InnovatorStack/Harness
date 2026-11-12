import { expect, test } from "bun:test";

import { AuthorizationMode, createHarness, ExecutionOutcome } from "../src/index.js";
import { principalFixtures, securityFixtures, securityProject } from "./helpers/security.js";

const writeOnlyPermission = `<Item type="Permission" action="add" id="SEC_WRITE_ONLY">
    <name>Write only</name><Relationships>
        <Item type="Access" action="add"><related_id>SEC_EDITORS</related_id>
            <can_update>1</can_update><can_delete>1</can_delete>
        </Item>
    </Relationships>
</Item>`;
const writeOnlyFixtures = `${principalFixtures}
    SecurityDocument: [{ name: "Write only", permission_id: { name: "Write only" } }],
`;

test("a write-only record can be edited with doGetItem=0 without granting Get", async () => {
    await using project = await securityProject(writeOnlyPermission, writeOnlyFixtures);
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });
    const original = h.state.getOne("SecurityDocument", { name: "Write only" });
    const result = await h.applyAML(
        `<Item type="SecurityDocument" action="edit" id="${original.id}" doGetItem="0">
            <name>Saved without Get</name>
        </Item>`,
    );

    expect(result.isError()).toBe(false);
    expect(result.getID()).not.toBe(original.id);
    expect(result.node.properties).toEqual({});
    expect(h.state.getOne("SecurityDocument", { id: result.getID() }).properties).toMatchObject({
        config_id: original.id,
        generation: 2,
        name: "Saved without Get",
    });
    expect(await h.get("SecurityDocument", { id: result.getID() })).toEqual([]);
});

test("a denied return Get rolls back a permitted write and all generation changes", async () => {
    await using project = await securityProject(writeOnlyPermission, writeOnlyFixtures);
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });
    const original = h.state.getOne("SecurityDocument", { name: "Write only" });
    const before = h.state.get("SecurityDocument");
    const result = await h.applyAML(
        `<Item type="SecurityDocument" action="edit" id="${original.id}">
            <name>Must roll back</name>
        </Item>`,
    );

    expect(result.isError()).toBe(true);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
    expect(h.state.get("SecurityDocument")).toEqual(before);
});

test("mutation selectors include write-only targets without filtering them through Get", async () => {
    const fixtures = `${principalFixtures}
        SecurityDocument: [
            { name: "Editable", permission_id: { name: "SEC_EDIT" } },
            { name: "Write only", permission_id: { name: "Write only" } },
        ],
    `;
    await using project = await securityProject(writeOnlyPermission, fixtures);
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });
    const records = h.state.get("SecurityDocument");
    const result = await h.applyAML(
        `<Item type="SecurityDocument" action="edit" idlist="${records.map((record) => record.id).join(",")}"
            doGetItem="0"><name>Both saved</name></Item>`,
    );

    expect(result.getItemCount()).toBe(2);
    expect(h.state.get("SecurityDocument", { is_current: 1 })).toHaveLength(2);
    expect(
        h.state.get("SecurityDocument", { is_current: 1 }).map((record) => record.properties.name),
    ).toEqual(["Both saved", "Both saved"]);
});

test.each(["idlist", "where"])(
    "a denied target in a %s mutation rolls back every selected record",
    async (selector) => {
        await using project = await securityProject("", securityFixtures);
        using h = await createHarness({
            cwd: project.cwd,
            authorization: AuthorizationMode.Native,
        });
        const before = h.state.get("SecurityDocument");
        const ids = before
            .filter((record) => ["Editable", "Hidden"].includes(String(record.properties.name)))
            .map((record) => record.id);
        const criteria =
            selector === "idlist"
                ? `idlist="${ids.join(",")}"`
                : "where=\"name in ('Editable', 'Hidden')\"";
        const result = await h.applyAML(
            `<Item type="SecurityDocument" action="edit" ${criteria} doGetItem="0">
                <name>Must roll back</name>
            </Item>`,
        );

        expect(result.getErrorCode()).toBe("PermissionDenied");
        expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
        expect(h.state.get("SecurityDocument")).toEqual(before);
    },
);
