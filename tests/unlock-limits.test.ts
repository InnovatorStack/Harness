import { expect, test } from "bun:test";

import { dataDepthMax } from "../src/core/limits.js";
import { createHarness, ExecutionOutcome } from "../src/index.js";
import { dependentUnlockProject } from "./helpers/unlock-dependents.js";

const schema = `<Item type="ItemType" action="add" id="DEEP_UNLOCK">
    <name>DeepUnlock</name><is_dependent>1</is_dependent><is_versionable>1</is_versionable>
    <Relationships><Item type="Property" action="add"><name>name</name><data_type>string</data_type></Item></Relationships>
</Item>
<Item type="ItemType" action="add" id="DeepUnlockRoots"><name>DeepUnlockRoots</name><is_relationship>1</is_relationship></Item>
<Item type="RelationshipType" action="add"><name>DeepUnlockRoots</name>
    <relationship_id>DeepUnlockRoots</relationship_id><source_id>REF_RECORD</source_id><related_id>DEEP_UNLOCK</related_id>
</Item>
<Item type="ItemType" action="add" id="DeepUnlockLinks"><name>DeepUnlockLinks</name><is_relationship>1</is_relationship></Item>
<Item type="RelationshipType" action="add"><name>DeepUnlockLinks</name>
    <relationship_id>DeepUnlockLinks</relationship_id><source_id>DEEP_UNLOCK</source_id><related_id>DEEP_UNLOCK</related_id>
</Item>`;

function graphProject(count: number, cycle: boolean) {
    const records = Array.from({ length: count }, (_, index) => ({
        name: `Node ${index}`,
        new_version: 1,
        locked_by_id: { login_name: "reference_owner" },
    }));
    const links = Array.from({ length: cycle ? count : count - 1 }, (_, index) => ({
        source_id: { name: `Node ${index}` },
        related_id: { name: `Node ${(index + 1) % count}` },
    }));
    const fixtures = `DeepUnlock: ${JSON.stringify(records)},
        DeepUnlockLinks: ${JSON.stringify(links)},
        DeepUnlockRoots: [{ source_id: { name: "First locked source" }, related_id: { name: "Node 0" } }],`;

    return dependentUnlockProject(schema, fixtures);
}

test("already-unlocked ancestors terminate a cyclic dependent graph", async () => {
    await using project = await graphProject(2, true);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const source = h.state.getOne("ReferenceRecord", { name: "First locked source" });
    const saved = await h.applyAML(
        `<Item type="ReferenceRecord" action="version" id="${source.id}" />`,
    );

    expect(saved.isError()).toBe(false);
    expect(
        h.state.get("DeepUnlock").every((record) => record.properties.locked_by_id === null),
    ).toBe(true);
    expect(h.state.get("DeepUnlock")).toHaveLength(2);
}, 60_000);

test("the depth limit rejects a dependent unlock chain atomically", async () => {
    await using project = await graphProject(dataDepthMax + 2, false);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const source = h.state.getOne("ReferenceRecord", { name: "First locked source" });
    const before = h.state.get("DeepUnlock");
    const sources = h.state.get("ReferenceRecord");

    await expect(
        h.applyAML(`<Item type="ReferenceRecord" action="version" id="${source.id}" />`),
    ).rejects.toMatchObject({ code: "ProtocolLimit" });
    expect(h.state.get("DeepUnlock")).toEqual(before);
    expect(h.state.get("ReferenceRecord")).toEqual(sources);
    expect(h.state.get("UnlockAudit")).toEqual([]);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
}, 60_000);
