import { expect, test } from "bun:test";

import { checkCompatibility, createHarness, ExecutionOutcome } from "../src/index.js";
import { referenceEvent, referenceMethod, referenceProject } from "./helpers/references.js";
import { revisionFixtures, revisionProject, revisionSchema } from "./helpers/revisions.js";

test("normal adds and automatic fixtures start at the imported revision sequence", async () => {
    await using project = await referenceProject(
        revisionSchema.replace("A C G", "03 04 A"),
        'RevisionDocument: [{ name: "Starting fixture" }]',
    );
    using h = await createHarness({ cwd: project.cwd });
    const fixture = await h.getOne("RevisionDocument", { name: "Starting fixture" });
    const created = await h.add("RevisionDocument", { name: "Created document" });
    const baseline = await h.add("ReferenceRecord", { name: "Baseline sequence" });

    expect(fixture.properties.major_rev).toBe("03");
    expect(created.properties.major_rev).toBe("03");
    expect(baseline.properties.major_rev).toBe("A");
    const invalid = await h.applyAML(
        '<Item type="RevisionDocument" action="add"><name>Invalid</name><major_rev>Z</major_rev></Item>',
    );
    expect(invalid.getErrorCode()).toBe("InvalidRevision");
    expect(h.state.get("RevisionDocument", { name: "Invalid" })).toHaveLength(0);
});

test("versioning a released item advances its declared revision and resets its lifecycle without losing history", async () => {
    await using project = await revisionProject();
    using h = await createHarness({ cwd: project.cwd });
    const original = await h.getOne("RevisionDocument", { name: "Released document" });
    const result = await h.applyAML(
        `<Item type="RevisionDocument" action="version" id="${original.id}"><name>Revised</name></Item>`,
    );
    const current = await h.getOne("RevisionDocument", { config_id: original.id, is_current: 1 });

    expect(current.id).toBe(result.getID());
    expect(current.id).not.toBe(original.id);
    expect(current.properties).toMatchObject({
        major_rev: "C",
        generation: 2,
        config_id: original.id,
        name: "Revised",
        state: "Draft",
        current_state: "REVISION_DRAFT",
        is_released: 0,
        not_lockable: 0,
        release_date: null,
        effective_date: null,
        superseded_date: null,
        permission_id: "9122CD065CF04141B8EFE263FC80BEA4",
    });
    expect(current.properties.locked_by_id).toBeTruthy();
    const history = h.state.getOne("RevisionDocument", { id: original.id });
    expect(history.properties).toMatchObject({
        major_rev: "A",
        generation: 1,
        is_current: 0,
        state: "Released",
        is_released: 1,
        not_lockable: 1,
        release_date: "2026-01-02T00:00:00",
        locked_by_id: null,
    });
});

test("an original C# Method can version its full fetched Item without overwriting the new revision with old state", async () => {
    const source = referenceMethod(
        "ReviseFetchedDocument",
        `
        var source = this.newItem("RevisionDocument", "get");
        source.setID(this.getID());
        source = source.apply();
        source.setAction("version");
        source.setProperty("name", "Revised by source");
        return source.apply();
    `,
    );
    await using project = await revisionProject(source);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const original = await h.getOne("RevisionDocument", { name: "Released document" });
    const result = await h.applyAML(
        `<Item type="RevisionDocument" action="ReviseFetchedDocument" id="${original.id}" />`,
    );
    const stored = h.state.getOne("RevisionDocument", { id: result.getID() });

    expect(stored.properties).toMatchObject({
        name: "Revised by source",
        major_rev: "C",
        state: "Draft",
        permission_id: "9122CD065CF04141B8EFE263FC80BEA4",
        is_released: 0,
        generation: 2,
    });
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.Committed);
    const compatibility = await checkCompatibility({ cwd: project.cwd, executions: h.executions });
    expect(compatibility.methods[0]?.executed).toBe(true);
}, 60_000);

test("unreleased saves keep the revision while their lock cycles continue advancing generations", async () => {
    await using project = await revisionProject();
    using h = await createHarness({ cwd: project.cwd });
    const released = await h.getOne("RevisionDocument", { name: "Released document" });
    const revised = await h.applyAML(
        `<Item type="RevisionDocument" action="version" id="${released.id}" />`,
    );
    await h.applyAML(
        `<Item type="RevisionDocument" action="update" id="${revised.getID()}"><name>Same lock</name></Item>`,
    );
    await h.applyAML(`<Item type="RevisionDocument" action="unlock" id="${revised.getID()}" />`);
    const record = await h.getOne("RevisionDocument", { id: revised.getID() });
    const saved = await h.update(record, { name: "Next lock" });

    expect(saved.properties).toMatchObject({
        major_rev: "C",
        generation: 3,
        config_id: released.id,
        state: "Draft",
        locked_by_id: null,
    });
    expect(h.state.get("RevisionDocument", { config_id: released.id })).toHaveLength(3);
});

test("version suppression cannot mutate released data even when its state permits locking", async () => {
    await using project = await referenceProject(
        revisionSchema.replace(
            "<set_not_lockable>1</set_not_lockable>",
            "<set_not_lockable>0</set_not_lockable>",
        ),
        revisionFixtures,
    );
    using h = await createHarness({ cwd: project.cwd });
    const released = await h.getOne("RevisionDocument", { name: "Released document" });
    const before = h.state.get("RevisionDocument");
    const result = await h.applyAML(
        `<Item type="RevisionDocument" action="edit" version="0" id="${released.id}"><name>Rejected</name></Item>`,
    );

    expect(result.getErrorCode()).toBe("ReleasedItem");
    expect(h.state.get("RevisionDocument")).toEqual(before);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
});

test("exhausted revision sequences reject with a business error and retain the entire stored state", async () => {
    await using project = await revisionProject(
        "",
        'RevisionDocument: [{ name: "Last revision", state: "Released", major_rev: "G" }]',
    );
    using h = await createHarness({ cwd: project.cwd });
    const record = await h.getOne("RevisionDocument", { name: "Last revision" });
    const before = h.state.get("RevisionDocument");
    const result = await h.applyAML(
        `<Item type="RevisionDocument" action="version" id="${record.id}" />`,
    );

    expect(result.getErrorCode()).toBe("RevisionSequenceExceeded");
    expect(h.state.get("RevisionDocument")).toEqual(before);
    expect(h.executions.at(-1)?.error?.capability).toBeUndefined();
});

test("revision resets clear lifecycle hard latches while retaining hard RelationshipType rules", async () => {
    await using project = await revisionProject();
    using h = await createHarness({ cwd: project.cwd });
    const parent = await h.getOne("RevisionDocument", { name: "Released document" });
    const child = await h.getOne("RevisionDocument", { name: "Draft document" });
    const link = await h.add("RevisionLink", { source_id: parent.id, related_id: child.id });
    await h.add("RevisionHardLink", { source_id: parent.id, related_id: child.id });
    const nextChild = await h.update(child, { name: "New child generation" });
    const parentVersion = await h.applyAML(
        `<Item type="RevisionDocument" action="version" id="${parent.id}" />`,
    );
    const copy = await h.getOne("RevisionLink", { source_id: parentVersion.getID() });
    const hard = await h.getOne("RevisionHardLink", { source_id: parentVersion.getID() });

    expect(link.properties.behavior).toBe("hard_fixed");
    expect(copy.properties).toMatchObject({ behavior: "float", related_id: nextChild.id });
    expect(hard.properties.behavior).toBe("hard_fixed");
    expect(h.state.getOne("RevisionLink", { id: link.id }).properties).toMatchObject({
        behavior: "hard_fixed",
        related_id: child.id,
        source_id: parent.id,
    });
});

test("a source hook rejection rolls back revised identities, reset flags, cloned links and nested writes together", async () => {
    const source =
        referenceMethod(
            "RejectRevision",
            `
        if (this.getProperty("major_rev") != "C" || this.getProperty("state") != "Draft")
            throw new Exception("The after-version context did not reset");
        var audit = this.newItem("ReferenceHolder", "add");
        audit.setProperty("name", "Must roll back");
        audit.apply();
        return this.getInnovator().newError("Reject revised document");
    `,
        ) + referenceEvent("REVISION_DOCUMENT", "onAfterVersion", "RejectRevision");
    await using project = await revisionProject(source);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const parent = await h.getOne("RevisionDocument", { name: "Released document" });
    const child = await h.getOne("RevisionDocument", { name: "Draft document" });
    await h.add("RevisionLink", { source_id: parent.id, related_id: child.id });
    const documents = h.state.get("RevisionDocument");
    const links = h.state.get("RevisionLink");
    const result = await h.applyAML(
        `<Item type="RevisionDocument" action="version" id="${parent.id}" />`,
    );

    expect(result.getErrorString()).toContain("Reject revised document");
    expect(h.state.get("RevisionDocument")).toEqual(documents);
    expect(h.state.get("RevisionLink")).toEqual(links);
    expect(h.state.get("ReferenceHolder")).toHaveLength(0);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
}, 60_000);

test("reset restores revision history and state, and the next world keeps an independent revision cycle", async () => {
    await using project = await revisionProject();
    using first = await createHarness({ cwd: project.cwd });
    using second = await createHarness({ cwd: project.cwd });
    const original = await first.getOne("RevisionDocument", { name: "Released document" });
    const before = first.state.get("RevisionDocument");
    const secondBefore = second.state.get("RevisionDocument");
    await first.applyAML(`<Item type="RevisionDocument" action="version" id="${original.id}" />`);

    expect(second.state.get("RevisionDocument")).toEqual(secondBefore);
    first.reset();
    expect(first.state.get("RevisionDocument")).toEqual(before);
    const result = await first.applyAML(
        `<Item type="RevisionDocument" action="version" id="${original.id}" />`,
    );
    expect(result.node.properties).toMatchObject({ generation: 2, major_rev: "C", state: "Draft" });
});
