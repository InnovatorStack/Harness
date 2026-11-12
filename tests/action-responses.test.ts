import { expect, test } from "bun:test";

import { createHarness, ExecutionOutcome } from "../src/index.js";
import { referenceEvent, referenceMethod, referenceProject } from "./helpers/references.js";

test.each(["add", "edit", "update"])(
    "%s doGetItem=0 returns only type and ID while persisting the write",
    async (action) => {
        await using project = await referenceProject();
        using h = await createHarness({ cwd: project.cwd });
        const target = await h.add("ReferenceHolder", { name: "Original" });
        const selector = action === "add" ? "" : `id="${target.id}"`;

        const result = await h.applyAML(
            `<Item type="ReferenceHolder" action="${action}" ${selector} doGetItem="0">
                <name>Changed</name>
            </Item>`,
        );

        expect(result.getType()).toBe("ReferenceHolder");
        expect(result.getID()).toMatch(/^[A-F0-9]{32}$/);
        expect(result.node.properties).toEqual({});
        expect(result.node.relationships).toEqual([]);
        expect(h.state.getOne("ReferenceHolder", { id: result.getID() }).properties.name).toBe(
            "Changed",
        );
    },
);

test.each(["", "1", "false"])("doGetItem=%s retains the full return phase", async (value) => {
    await using project = await referenceProject();
    using h = await createHarness({ cwd: project.cwd });
    const result = await h.applyAML(
        `<Item type="ReferenceHolder" action="add" doGetItem="${value}">
            <name>Full response</name>
        </Item>`,
    );

    expect(result.getProperty("name")).toBe("Full response");
});

test.each(["0", "1"])(
    "add captures doGetItem=%s before its before hook",
    async (value) => {
        const changed = value === "0" ? "1" : "0";
        const source =
            referenceMethod(
                "ChangeReturnFlag",
                `this.setAttribute("doGetItem", "${changed}"); return this;`,
            ) + referenceEvent("REF_HOLDER", "onBeforeAdd", "ChangeReturnFlag");
        await using project = await referenceProject(source);
        using h = await createHarness({ cwd: project.cwd, csharp: {} });
        const result = await h.applyAML(
            `<Item type="ReferenceHolder" action="add" doGetItem="${value}">
            <name>Stored</name>
        </Item>`,
        );

        expect(result.getProperty("name")).toBe(value === "0" ? "" : "Stored");
        expect(h.state.getOne("ReferenceHolder", { id: result.getID() }).properties.name).toBe(
            "Stored",
        );
    },
    60_000,
);

test("get ignores doGetItem=0 and delete returns its native acknowledgement", async () => {
    await using project = await referenceProject();
    using h = await createHarness({ cwd: project.cwd });
    const target = await h.add("ReferenceHolder", { name: "Delete me" });
    const result = await h.applyAML(
        `<Item type="ReferenceHolder" action="get" id="${target.id}" doGetItem="0" />`,
    );

    expect(result.getProperty("name")).toBe("Delete me");
    const deleted = await h.applyAML(
        `<Item type="ReferenceHolder" action="delete" id="${target.id}" doGetItem="0" />`,
    );

    expect(deleted.getResult()).toBe("Ok");
    expect(deleted.getItemCount()).toBe(0);
    expect(h.state.get("ReferenceHolder")).toEqual([]);
});

test("minimal lock and unlock responses retain lock state and versioning", async () => {
    await using project = await referenceProject();
    using h = await createHarness({ cwd: project.cwd });
    const original = h.state.getOne("ReferenceRecord", { name: "Parent" });
    const locked = await h.applyAML(
        `<Item type="ReferenceRecord" action="lock" id="${original.id}" doGetItem="0" />`,
    );

    expect(locked.getResult()).toBe("Ok.");
    expect(locked.getItemCount()).toBe(0);
    expect(h.state.getOne("ReferenceRecord", { id: original.id }).properties.locked_by_id).toBe(
        h.state.getOne("User", { login_name: "reference_owner" }).id,
    );
    const updated = await h.applyAML(
        `<Item type="ReferenceRecord" action="update" id="${original.id}" doGetItem="0">
            <name>New generation</name>
        </Item>`,
    );

    expect(updated.getID()).not.toBe(original.id);
    expect(updated.node.properties).toEqual({});
    expect(h.state.getOne("ReferenceRecord", { id: updated.getID() }).properties).toMatchObject({
        config_id: original.id,
        generation: 2,
        name: "New generation",
    });
    const unlocked = await h.applyAML(
        `<Item type="ReferenceRecord" action="unlock" id="${updated.getID()}" doGetItem="0" />`,
    );

    expect(unlocked.getResult()).toBe("Ok.");
    expect(unlocked.getItemCount()).toBe(0);
    expect(
        h.state.getOne("ReferenceRecord", { id: updated.getID() }).properties.locked_by_id,
    ).toBeNull();
});

const responseHooks =
    referenceMethod("TransientMutation", 'this.setProperty("name", "Transient"); return this;') +
    referenceMethod(
        "HydrateResponse",
        `if (this.getProperty("name") == "Reject response" && this.getProperty("locked_by_id") == "") {
            return this.getInnovator().newError("Response rejected");
        }
        this.setProperty("name", this.getProperty("name") + " from Get");
        return this;`,
    ) +
    referenceEvent("REF_RECORD", "onAfterUpdate", "TransientMutation") +
    referenceEvent("REF_RECORD", "onAfterGet", "HydrateResponse");

test("full mutation results come from Get after update and unlock hooks finish", async () => {
    await using project = await referenceProject(responseHooks);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const original = h.state.getOne("ReferenceRecord", { name: "Parent" });
    const result = await h.applyAML(
        `<Item type="ReferenceRecord" action="edit" id="${original.id}"><name>Stored</name></Item>`,
    );

    expect(result.getProperty("name")).toBe("Stored from Get");
    expect(h.state.getOne("ReferenceRecord", { id: result.getID() }).properties.name).toBe(
        "Stored",
    );
    expect(h.trace.filter((entry) => entry.kind === "event").map((entry) => entry.name)).toEqual([
        "onAfterGet",
        "onAfterUpdate",
        "onAfterGet",
    ]);
}, 60_000);

test("a failing return Get rolls back the write, generation and internal locks", async () => {
    await using project = await referenceProject(responseHooks);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const original = h.state.getOne("ReferenceRecord", { name: "Parent" });
    const before = h.state.get("ReferenceRecord");
    const rejected = await h.applyAML(
        `<Item type="ReferenceRecord" action="edit" id="${original.id}">
            <name>Reject response</name>
        </Item>`,
    );

    expect(rejected.getErrorString()).toBe("Response rejected");
    expect(h.state.get("ReferenceRecord")).toEqual(before);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
    const saved = await h.applyAML(
        `<Item type="ReferenceRecord" action="edit" id="${original.id}" doGetItem="0">
            <name>Reject response</name>
        </Item>`,
    );

    expect(saved.isError()).toBe(false);
    expect(saved.node.properties).toEqual({});
    expect(h.state.getOne("ReferenceRecord", { id: saved.getID() }).properties.name).toBe(
        "Reject response",
    );
}, 60_000);

test.each([
    { afterAdd: false, explicit: "", expected: "0" },
    { afterAdd: true, explicit: "", expected: "1" },
    { afterAdd: true, explicit: 'doGetItem="0"', expected: "0" },
    { afterAdd: false, explicit: 'doGetItem="1"', expected: "1" },
])(
    "nested return defaults and overrides: %j",
    async ({ afterAdd, explicit, expected }) => {
        const source =
            referenceMethod(
                "ChildResponseFlag",
                `if (this.getAttribute("doGetItem") != "${expected}") {
                return this.getInnovator().newError("Incorrect nested response flag");
            }
            return this;`,
            ) +
            referenceMethod("ChildAfterAdd", "return this;") +
            referenceMethod("ChildAfterGet", "return this;") +
            referenceEvent("REF_NOTE", "onBeforeAdd", "ChildResponseFlag") +
            referenceEvent("REF_NOTE", "onAfterGet", "ChildAfterGet") +
            (afterAdd ? referenceEvent("REF_NOTE", "onAfterAdd", "ChildAfterAdd") : "");
        await using project = await referenceProject(source);
        using h = await createHarness({ cwd: project.cwd, csharp: {} });
        const result = await h.applyAML(
            `<Item type="ReferenceHolder" action="add"><name>Owner</name><note>
            <Item type="ReferenceNote" action="add" ${explicit}><name>Nested</name></Item>
        </note></Item>`,
        );

        expect(result.isError()).toBe(false);
        expect(h.state.getOne("ReferenceNote", { name: "Nested" }).id).toBe(
            result.getProperty("note"),
        );
        expect(
            h.trace.filter((entry) => entry.kind === "event" && entry.name === "onAfterGet"),
        ).toHaveLength(Number(expected) + Number(afterAdd));
    },
    60_000,
);

test("a real C# Method can write with a minimal result and fetch the persisted generation", async () => {
    const source = referenceMethod(
        "SaveMinimal",
        `var edit = this.getInnovator().newItem("ReferenceRecord", "edit");
        edit.setID(this.getProperty("record"));
        edit.setAttribute("doGetItem", "0");
        edit.setProperty("name", "Saved by source");
        var saved = edit.apply();
        if (saved.isError()) { return saved; }
        var query = this.getInnovator().newItem("ReferenceRecord", "get");
        query.setID(saved.getID());
        return query.apply();`,
    );
    await using project = await referenceProject(source);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const original = h.state.getOne("ReferenceRecord", { name: "Parent" });
    const result = await h.callMethod("SaveMinimal", { record: original.id });

    expect(result.isError()).toBe(false);
    expect(result.getID()).not.toBe(original.id);
    expect(result.getProperty("name")).toBe("Saved by source");
    expect(result.getProperty("config_id")).toBe(original.id);
    expect(result.getProperty("generation")).toBe("2");
    expect(h.executions.at(-1)?.mocks).toEqual([]);
}, 60_000);

test("a replacement retains its own message instead of invoking default result retrieval", async () => {
    const source =
        referenceMethod("ReplaceUpdate", 'return this.getInnovator().newResult("Replacement");') +
        referenceMethod("UnexpectedGet", 'throw new Exception("Get must not run");') +
        referenceEvent("REF_HOLDER", "onUpdate", "ReplaceUpdate") +
        referenceEvent("REF_HOLDER", "onBeforeGet", "UnexpectedGet");
    const fixtures = 'ReferenceHolder: [{ name: "Original" }],';
    await using project = await referenceProject(source, fixtures);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const original = h.state.getOne("ReferenceHolder", { name: "Original" });
    const result = await h.applyAML(
        `<Item type="ReferenceHolder" action="update" id="${original.id}">
            <name>Unapplied</name>
        </Item>`,
    );

    expect(result.getResult()).toBe("Replacement");
    expect(h.state.getOne("ReferenceHolder", { id: original.id }).properties.name).toBe("Original");
}, 60_000);

test("collection text replacements fail explicitly instead of silently discarding their results", async () => {
    const source =
        referenceMethod(
            "ReplaceCollection",
            'return this.getInnovator().newResult("Replacement");',
        ) + referenceEvent("REF_HOLDER", "onUpdate", "ReplaceCollection");
    const fixtures = 'ReferenceHolder: [{ name: "First" }, { name: "Second" }],';
    await using project = await referenceProject(source, fixtures);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const before = h.state.get("ReferenceHolder");

    await expect(
        h.applyAML('<Item type="ReferenceHolder" action="update" where="name is not null" />'),
    ).rejects.toMatchObject({ code: "UnsupportedBatchResult" });

    expect(h.state.get("ReferenceHolder")).toEqual(before);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
}, 60_000);
