import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHarness, ExecutionOutcome } from "../src/index.js";
import type { HarnessOptions } from "../src/index.js";

const directories: string[] = [];
const schema = `<Item type="ItemType" action="add" id="AUDITED_RECORD">
  <name>AuditedRecord</name><is_versionable>0</is_versionable><Relationships>
    <Item type="Property" action="add"><name>name</name><data_type>string</data_type><is_required>1</is_required></Item>
    <Item type="Property" action="add"><name>created_on</name><data_type>date</data_type><is_required>1</is_required></Item>
    <Item type="Property" action="add"><name>created_by_id</name><data_type>item</data_type><is_required>1</is_required><data_source><Item type="ItemType" action="get"><name>User</name></Item></data_source></Item>
  </Relationships>
</Item>`;

async function project(extraSchema = "", extraFixtures = ""): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "harness-creation-"));
    directories.push(directory);
    await mkdir(join(directory, ".harness/packages"), { recursive: true });
    await Bun.write(
        join(directory, ".harness/packages/schema.xml"),
        `<AML>${schema}${extraSchema}</AML>`,
    );
    await Bun.write(
        join(directory, ".harness/fixtures.ts"),
        `export default {
    User: [{login_name: "creator", created_on: "2026-01-01T00:00:00", created_by_id: {login_name: "creator"}}],
    ${extraFixtures}
  };`,
    );

    return directory;
}

const session: HarnessOptions["session"] = { user: { login_name: "creator" } };

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
});

test("normal add supplies required native creation fields from time and the configured User", async () => {
    const directory = await project();
    using h = await createHarness({ cwd: directory, csharp: false, session });
    const user = await h.getOne("User", { login_name: "creator" });
    const start = Date.now();

    const record = await h.add("AuditedRecord", { name: "Created" });

    expect(record.properties.created_by_id).toBe(user.id);
    const timestamp = Date.parse(String(record.properties.created_on));
    expect(timestamp).toBeGreaterThanOrEqual(start);
    expect(timestamp).toBeLessThanOrEqual(Date.now());
    expect(await h.getOne("AuditedRecord", { id: record.id })).toEqual(record);
});

test("fixture imports retain supplied audit data and unrelated required fields remain enforced", async () => {
    const directory = await project(
        "",
        'AuditedRecord: [{name: "Captured", created_on: "2020-05-06T00:00:00", created_by_id: {login_name: "creator"}}],',
    );
    using h = await createHarness({ cwd: directory, csharp: false, session });

    expect((await h.getOne("AuditedRecord", { name: "Captured" })).properties.created_on).toBe(
        "2020-05-06T00:00:00",
    );
    await expect(h.add("AuditedRecord", {})).rejects.toMatchObject({ code: "RequiredProperty" });
    expect(await h.get("AuditedRecord")).toHaveLength(1);
});

test("missing User sessions fail required creation identity resolution before insertion", async () => {
    const directory = await project();
    using h = await createHarness({ cwd: directory, csharp: false });

    await expect(h.add("AuditedRecord", { name: "Cannot create" })).rejects.toMatchObject({
        code: "SessionRequired",
    });
    expect(h.executions.at(-1)?.changes).toEqual([]);
    expect(await h.get("AuditedRecord")).toEqual([]);
});

test("creation defaults share the action transaction and remain visible in rolled-back changes", async () => {
    const directory = await project(`
    <Item type="Method" action="add" id="REJECT"><name>RejectAuditedAdd</name><method_type>C#</method_type><method_code>return this;</method_code></Item>
    <Item type="Server Event" action="add"><source_id>AUDITED_RECORD</source_id><related_id>REJECT</related_id><server_event>onAfterAdd</server_event><sort_order>10</sort_order></Item>
  `);
    using h = await createHarness({
        cwd: directory,
        csharp: false,
        session,
        mocks: [{ method: "RejectAuditedAdd", response: { error: "Rejected after insertion" } }],
    });

    await expect(h.add("AuditedRecord", { name: "Transient" })).rejects.toThrow(
        "Rejected after insertion",
    );
    const run = h.executions.at(-1);

    expect(run?.outcome).toBe(ExecutionOutcome.RolledBack);
    expect(run?.changes[0]?.after?.properties.created_on).toBeDefined();
    expect(run?.changes[0]?.after?.properties.created_by_id).toBeDefined();
    expect(await h.get("AuditedRecord")).toEqual([]);
});
