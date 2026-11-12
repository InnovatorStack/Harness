import { expect, test } from "bun:test";

import { createHarness, ExecutionOutcome } from "../src/index.js";
import { ServerEventVersion } from "../src/platform/events/types.js";
import { referenceEvent, referenceMethod, referenceProject } from "./helpers/references.js";

const auditSchema = `<Item type="ItemType" action="add" id="EVENT_AUDIT"><name>EventAudit</name><Relationships>
    <Item type="Property" action="add"><name>phase</name><data_type>string</data_type></Item>
    <Item type="Property" action="add"><name>count</name><data_type>integer</data_type></Item>
</Relationships></Item>`;
const holders = 'ReferenceHolder: [{ name: "First" }, { name: "Second" }]';

function audit(name: string, event: string, count: number, version: ServerEventVersion): string {
    const source = referenceMethod(
        name,
        `
        if (this.getItemCount() != ${count}) throw new Exception("Wrong event context count");
        var audit = this.newItem("EventAudit", "add");
        audit.setProperty("phase", "${name}");
        audit.setProperty("count", this.getItemCount().ToString());
        audit.apply();
        return this;
    `,
    );

    return source + referenceEvent("REF_HOLDER", event, name, { version });
}

test("bulk updates run item hooks per record and one collection hook with every result", async () => {
    const source =
        auditSchema +
        audit("Before", "onBeforeUpdate", 1, ServerEventVersion.Item) +
        audit("After", "onAfterUpdate", 1, ServerEventVersion.Item) +
        audit("Collection", "onAfterUpdate", 2, ServerEventVersion.Collection);
    await using project = await referenceProject(source, holders);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const result = await h.applyAML(`<Item type="ReferenceHolder" action="update"
        where="name IN ('First', 'Second')"><name>Changed</name></Item>`);

    expect(result.getItemCount()).toBe(2);
    const run = h.executions.at(-1);
    expect(run?.outcome).toBe(ExecutionOutcome.Committed);
    expect(h.trace.filter((event) => event.kind === "method").map((event) => event.name)).toEqual([
        "Before",
        "After",
        "Before",
        "After",
        "Collection",
    ]);
    expect(h.state.get("ReferenceHolder", { name: "Changed" })).toHaveLength(2);
    expect(h.state.get("EventAudit", { phase: "Collection" })).toHaveLength(1);
}, 60_000);

test("versioned bulk edits expose all new generations before update and unlock after collection hooks", async () => {
    const source =
        auditSchema +
        referenceMethod(
            "VersionCollection",
            `
        if (this.getItemCount() != 2) throw new Exception("Missing version results");
        for (int index = 0; index < this.getItemCount(); index++) {
            var item = this.getItemByIndex(index);
            if (item.getProperty("generation") != "2") throw new Exception("Wrong generation");
            if (item.getProperty("name") == "Changed") throw new Exception("Update ran before version collection");
        }
        return this;
    `,
        ) +
        referenceEvent("REF_RECORD", "onAfterVersion", "VersionCollection", {
            version: ServerEventVersion.Collection,
        }) +
        referenceMethod(
            "UpdateCollection",
            `
        if (this.getItemCount() != 2) throw new Exception("Missing update results");
        for (int index = 0; index < this.getItemCount(); index++) {
            var item = this.getItemByIndex(index);
            if (item.getProperty("name") != "Changed") throw new Exception("Missing updates");
            if (item.getProperty("locked_by_id") != this.getInnovator().getUserID()) throw new Exception("Unlocked before collection hook");
        }
        return this;
    `,
        ) +
        referenceEvent("REF_RECORD", "onAfterUpdate", "UpdateCollection", {
            version: ServerEventVersion.Collection,
        });
    await using project = await referenceProject(source);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const before = h.state.get("ReferenceRecord");
    const result = await h.applyAML(`<Item type="ReferenceRecord" action="edit"
        where="name IN ('Parent', 'Child')"><name>Changed</name></Item>`);

    expect(result.getItemCount()).toBe(2);
    expect(result.payload.items.every((item) => item.properties.locked_by_id === null)).toBe(true);
    expect(h.state.get("ReferenceRecord", { name: "Changed" })).toHaveLength(2);
    expect(h.trace.filter((event) => event.kind === "method").map((event) => event.name)).toEqual([
        "VersionCollection",
        "UpdateCollection",
    ]);
    expect(
        before
            .filter((record) => ["Parent", "Child"].includes(String(record.properties.name)))
            .every(
                (record) =>
                    h.state.getOne("ReferenceRecord", { id: record.id }).properties.is_current ===
                    0,
            ),
    ).toBe(true);
}, 60_000);

test("a failing collection Method rolls back every generation, lock and nested write", async () => {
    const source =
        auditSchema +
        referenceMethod(
            "RejectCollection",
            `
        var audit = this.newItem("EventAudit", "add");
        audit.setProperty("phase", "Must roll back");
        audit.apply();
        return this.getInnovator().newError("Reject all updates");
    `,
        ) +
        referenceEvent("REF_RECORD", "onAfterUpdate", "RejectCollection", {
            version: ServerEventVersion.Collection,
        });
    await using project = await referenceProject(source);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const before = h.state.get("ReferenceRecord");
    const result = await h.applyAML(`<Item type="ReferenceRecord" action="edit"
        where="name IN ('Parent', 'Child')"><name>Rejected</name></Item>`);

    expect(result.getErrorString()).toContain("Reject all updates");
    expect(h.state.get("ReferenceRecord")).toEqual(before);
    expect(h.state.get("EventAudit")).toHaveLength(0);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
}, 60_000);

test("required collection events survive serverEvents=0 while optional events stay suppressed", async () => {
    const source =
        referenceMethod("OptionalCollection", 'throw new Exception("Optional hook ran");') +
        referenceEvent("REF_HOLDER", "onAfterUpdate", "OptionalCollection", {
            version: ServerEventVersion.Collection,
            order: 10,
        }) +
        referenceMethod(
            "RequiredCollection",
            `
            if (this.getItemCount() != 2) throw new Exception("Required hook lost its collection");
            return this;
        `,
        ) +
        referenceEvent("REF_HOLDER", "onAfterUpdate", "RequiredCollection", {
            version: ServerEventVersion.Collection,
            order: 20,
            required: true,
        });
    await using project = await referenceProject(source, holders);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const result = await h.applyAML(`<Item type="ReferenceHolder" action="update" serverEvents="0"
        where="name IN ('First', 'Second')"><name>Changed</name></Item>`);

    expect(result.getItemCount()).toBe(2);
    expect(h.trace.filter((event) => event.kind === "method").map((event) => event.name)).toEqual([
        "RequiredCollection",
    ]);
}, 60_000);

test("unconditional collection mocks bypass the original executor through the normal dispatcher", async () => {
    const source =
        referenceMethod("MockedCollection", "malformed C# source") +
        referenceEvent("REF_HOLDER", "onAfterUpdate", "MockedCollection", {
            version: ServerEventVersion.Collection,
        });
    await using project = await referenceProject(source, holders);
    using h = await createHarness({
        cwd: project.cwd,
        csharp: false,
        mocks: [{ method: "MockedCollection", response: { text: "Mocked collection" } }],
    });
    const result = await h.applyAML(`<Item type="ReferenceHolder" action="update"
        where="name IN ('First', 'Second')"><name>Changed</name></Item>`);

    expect(result.getResult()).toBe("Mocked collection");
    expect(h.state.get("ReferenceHolder", { name: "Changed" })).toHaveLength(2);
    expect(h.executions.at(-1)?.mocks).toHaveLength(1);
    expect(h.executions.at(-1)?.calls[0]?.children[0]?.executed).toBe(false);
});

test("after-add collections see persisted relationships and a rejection removes the whole creation", async () => {
    const source =
        referenceMethod(
            "RejectAddedParent",
            `
        if (this.getItemCount() != 1) throw new Exception("Wrong add context");
        var query = this.newItem("ReferenceFixed", "get");
        query.setProperty("source_id", this.getID());
        if (query.apply().getItemCount() != 1) throw new Exception("Nested relationship is missing");
        return this.getInnovator().newError("Reject added graph");
    `,
        ) +
        referenceEvent("REF_RECORD", "onAfterAdd", "RejectAddedParent", {
            version: ServerEventVersion.Collection,
        });
    await using project = await referenceProject(source);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const before = h.state.get("ReferenceRecord");
    const child = await h.getOne("ReferenceRecord", { name: "Child" });
    const result = await h.applyAML(`<Item type="ReferenceRecord" action="add"><name>Rejected</name>
        <Relationships><Item type="ReferenceFixed" action="add"><related_id>${child.id}</related_id></Item></Relationships>
    </Item>`);

    expect(result.getErrorString()).toContain("Reject added graph");
    expect(h.state.get("ReferenceRecord")).toEqual(before);
    expect(h.state.get("ReferenceFixed")).toHaveLength(0);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
}, 60_000);
