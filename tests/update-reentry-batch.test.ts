import { expect, test } from "bun:test";
import { join } from "node:path";

import { createHarness } from "../src/index.js";
import { referenceEvent, referenceMethod, referenceProject } from "./helpers/references.js";
import { updateEventSources } from "./helpers/update-events.js";

async function batchProject(extra = "") {
    const project = await referenceProject(updateEventSources + extra);
    await Bun.write(
        join(project.cwd, ".harness/fixtures/batch.xml"),
        `<AML>
            <Item type="ReferenceRecord" action="add"><name>First</name><new_version>1</new_version></Item>
            <Item type="ReferenceRecord" action="add"><name>Second</name><new_version>0</new_version></Item>
        </AML>`,
    );

    return project;
}

test.each([false, true])(
    "the first version decision restarts the entire selected batch: reversed=%s",
    async (reversed) => {
        await using project = await batchProject();
        using h = await createHarness({ cwd: project.cwd, csharp: {} });
        const first = h.state.getOne("ReferenceRecord", { name: "First" });
        const second = h.state.getOne("ReferenceRecord", { name: "Second" });
        const targets = reversed ? [second, first] : [first, second];
        const ids = targets.map((record) => record.id).join(",");
        const saved = await h.applyAML(
            `<Item type="ReferenceRecord" action="edit" idlist="${ids}"><name>Bulk save</name></Item>`,
        );
        const audits = h.state.get("UpdateAudit");

        expect(saved.getItemCount()).toBe(2);
        expect(saved.payload.items.map((item) => item.properties.config_id)).toEqual(
            targets.map((record) => record.id),
        );
        expect(saved.payload.items.every((item) => item.properties.generation === 2)).toBe(true);
        expect(audits.filter((audit) => audit.properties.phase === "preflight")).toHaveLength(
            reversed ? 1 : 2,
        );
        expect(audits.filter((audit) => audit.properties.phase === "version")).toHaveLength(2);
        const reentry = audits.filter((audit) => audit.properties.phase === "reentry");

        expect(reentry).toHaveLength(2);
        expect(reentry.every((audit) => audit.properties.old_id === ids)).toBe(true);
        expect(h.state.getOne("ReferenceRecord", { id: first.id }).properties.name).toBe(
            reversed ? "First" : "Bulk save",
        );
        expect(h.state.getOne("ReferenceRecord", { id: second.id }).properties.name).toBe("Second");
        expect(h.state.get("ReferenceRecord", { name: "Bulk save", is_current: 1 })).toHaveLength(
            2,
        );
    },
    60_000,
);

test("before-version Methods share pending data across every selected source", async () => {
    const source =
        referenceMethod(
            "AccumulateVersionInput",
            `this.setProperty("name", this.getProperty("name") + "/version"); return this;`,
        ) +
        referenceEvent("REF_RECORD", "onBeforeVersion", "AccumulateVersionInput", { order: 10 });
    await using project = await batchProject(source);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const first = h.state.getOne("ReferenceRecord", { name: "First" });
    const second = h.state.getOne("ReferenceRecord", { name: "Second" });
    const saved = await h.applyAML(
        `<Item type="ReferenceRecord" action="version" idlist="${first.id},${second.id}"><name>Pending</name></Item>`,
    );

    expect(saved.getItemCount()).toBe(2);
    expect(saved.payload.items.map((item) => item.properties.name)).toEqual([
        "Pending/version/version",
        "Pending/version/version",
    ]);
    expect(
        h.state.getOne("UpdateAudit", { phase: "version", record_id: first.id }).properties
            .pending_name,
    ).toBe("Pending");
    expect(
        h.state.getOne("UpdateAudit", { phase: "version", record_id: second.id }).properties
            .pending_name,
    ).toBe("Pending/version");
    expect(h.state.getOne("ReferenceRecord", { id: first.id }).properties.name).toBe("First");
    expect(h.state.getOne("ReferenceRecord", { id: second.id }).properties.name).toBe("Second");
}, 60_000);

test("after-update Methods run after every generated record has been saved", async () => {
    const source =
        referenceMethod(
            "VerifyCompletedBatch",
            `
            var query = this.newItem("ReferenceRecord", "get");
            query.setProperty("name", "Completed batch");
            var records = query.apply();
            if (records.getItemCount() != 2) {
                throw new Exception("An after-update Method ran before the batch finished");
            }
            return this;
        `,
        ) + referenceEvent("REF_RECORD", "onAfterUpdate", "VerifyCompletedBatch");
    await using project = await batchProject(source);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const saved = await h.applyAML(
        `<Item type="ReferenceRecord" action="edit" where="name IN ('First', 'Second')"><name>Completed batch</name></Item>`,
    );

    expect(saved.isError()).toBe(false);
    expect(saved.getItemCount()).toBe(2);
    expect(
        h.trace.filter((event) => event.kind === "method" && event.name === "VerifyCompletedBatch"),
    ).toHaveLength(2);
}, 60_000);

test("a failed reentry rolls back updates performed before the batch restarted", async () => {
    await using project = await batchProject();
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const first = h.state.getOne("ReferenceRecord", { name: "First" });
    const second = h.state.getOne("ReferenceRecord", { name: "Second" });
    const before = h.state.get("ReferenceRecord");
    const saved = await h.applyAML(
        `<Item type="ReferenceRecord" action="edit" idlist="${first.id},${second.id}"><name>Reject reentry</name></Item>`,
    );

    expect(saved.getErrorString()).toBe("Rejected after versioning");
    expect(h.state.get("ReferenceRecord")).toEqual(before);
    expect(h.state.get("UpdateAudit")).toEqual([]);
    expect(h.executions.at(-1)?.changes.filter((change) => change.name === "version")).toHaveLength(
        2,
    );
    expect(
        h.executions.at(-1)?.changes.filter((change) => change.name === "update").length,
    ).toBeGreaterThan(0);
}, 60_000);

test("repeated bulk IDs fail before any hooks or locks run", async () => {
    await using project = await batchProject();
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const first = h.state.getOne("ReferenceRecord", { name: "First" });
    const before = h.state.get("ReferenceRecord");

    await expect(
        h.applyAML(
            `<Item type="ReferenceRecord" action="edit" idlist="${first.id},${first.id}" />`,
        ),
    ).rejects.toMatchObject({ code: "InvalidSelector" });
    expect(h.state.get("ReferenceRecord")).toEqual(before);
    expect(h.state.get("UpdateAudit")).toEqual([]);
});
