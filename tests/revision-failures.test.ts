import { expect, test } from "bun:test";

import { CapabilityId, checkCompatibility, createHarness, ExecutionOutcome } from "../src/index.js";
import { referenceProject } from "./helpers/references.js";
import { revisionFixtures, revisionProject, revisionSchema } from "./helpers/revisions.js";

test("an unknown revision in a later bulk target rolls back earlier generations and relationship copies", async () => {
    const fixtures = `RevisionDocument: [
        { name: "A valid", major_rev: "A", state: "Released" },
        { name: "Z invalid", major_rev: "Z", state: "Released" },
    ]`;
    await using project = await revisionProject("", fixtures);
    using h = await createHarness({ cwd: project.cwd });
    const records = h.state.get("RevisionDocument");
    const first = h.state.getOne("RevisionDocument", { name: "A valid" });
    const last = h.state.getOne("RevisionDocument", { name: "Z invalid" });
    await h.add("RevisionLink", { source_id: first.id, related_id: last.id });
    const links = h.state.get("RevisionLink");
    const result = await h.applyAML(`<Item type="RevisionDocument" action="version" orderBy="name"
        idlist="${first.id},${last.id}" />`);

    expect(result.getErrorCode()).toBe("InvalidRevision");
    expect(h.state.get("RevisionDocument")).toEqual(records);
    expect(h.state.get("RevisionLink")).toEqual(links);
    expect(h.executions.at(-1)?.changes.some((change) => change.name === "version")).toBe(true);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
});

test("sequence metadata failures have the same capability and source in preflight and execution", async () => {
    await using project = await referenceProject(
        revisionSchema.replace("A C G", "A A"),
        'RevisionDocument: [{ name: "Released", major_rev: "A", state: "Released" }]',
    );
    const report = await checkCompatibility({ cwd: project.cwd });
    const issue = report.issues.find((issue) => issue.causeCode === "InvalidRevisionSequence");

    expect(report.packages.canImport).toBe(true);
    expect(issue?.capability).toBe(CapabilityId.Revision);
    expect(issue?.source?.file).toEndWith("source.xml");
    using h = await createHarness({ cwd: project.cwd });
    const record = await h.getOne("RevisionDocument", { name: "Released" });
    await expect(
        h.applyAML(`<Item type="RevisionDocument" action="version" id="${record.id}" />`),
    ).rejects.toMatchObject({ code: "InvalidRevisionSequence", capability: CapabilityId.Revision });
    expect(h.state.get("RevisionDocument")).toHaveLength(1);
});

test("an explicitly absent Revision sequence remains absent and cannot silently use the default", async () => {
    await using project = await referenceProject(
        revisionSchema.replace(
            "<revisions>REVISION_SEQUENCE</revisions>",
            '<revisions is_null="1" />',
        ),
        revisionFixtures,
    );
    using h = await createHarness({ cwd: project.cwd });
    const record = await h.getOne("RevisionDocument", { name: "Released document" });
    const before = h.state.get("RevisionDocument");
    await expect(
        h.applyAML(`<Item type="RevisionDocument" action="version" id="${record.id}" />`),
    ).rejects.toMatchObject({ code: "MissingRevisionSequence", capability: CapabilityId.Revision });

    expect(h.state.get("RevisionDocument")).toEqual(before);
});

test("another User's lock prevents revision without touching either generation", async () => {
    await using project = await revisionProject(
        "",
        `RevisionDocument: [{ name: "Other lock",
        state: "Released", major_rev: "A", locked_by_id: { login_name: "admin" } }]`,
    );
    using h = await createHarness({ cwd: project.cwd });
    const record = await h.getOne("RevisionDocument", { name: "Other lock" });
    const before = h.state.get("RevisionDocument");
    await expect(
        h.applyAML(`<Item type="RevisionDocument" action="version" id="${record.id}" />`),
    ).rejects.toThrow("locked by another User");

    expect(h.state.get("RevisionDocument")).toEqual(before);
});

test("a version request cannot replace reset values with an unrelated lifecycle state or revision", async () => {
    await using project = await revisionProject();
    using h = await createHarness({ cwd: project.cwd });
    const record = await h.getOne("RevisionDocument", { name: "Released document" });
    const before = h.state.get("RevisionDocument");
    await expect(
        h.applyAML(`<Item type="RevisionDocument" action="version" id="${record.id}">
        <major_rev>G</major_rev><state>Unrelated</state></Item>`),
    ).rejects.toMatchObject({ code: "ReadOnlyProperty" });

    expect(h.state.get("RevisionDocument")).toEqual(before);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
});
