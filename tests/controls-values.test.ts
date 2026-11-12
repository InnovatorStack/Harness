import { expect, test } from "bun:test";
import { join } from "node:path";

import { createHarness, fixedClock, seededIds } from "../src/index.js";
import { controlProject } from "./helpers/controls.js";

test("shared clock settings drive creation timestamps and report dates without freezing host time", async () => {
    await using project = await controlProject();
    using h = await createHarness({ cwd: project.cwd });
    const record = await h.add("ControlAudit", { name: "Timed" });
    expect(record.properties.created_on).toBe("2026-01-01T09:00:00.000Z");
    expect(h.executions.at(-1)?.startedAt).toBe("2026-01-01T09:00:00.000Z");
    expect(h.executions.at(-1)?.durationMs).toBeGreaterThanOrEqual(0);
    h.clock.advance(60_000);
    expect(h.clock.now().toISOString()).toBe("2026-01-01T09:01:00.000Z");
    const date = h.clock.now();
    date.setUTCFullYear(2000);
    expect(h.clock.now().getUTCFullYear()).toBe(2026);
});

test("reset restores the post-setup ID position, fixture identities and controlled time", async () => {
    await using project = await controlProject();
    using h = await createHarness({ cwd: project.cwd });
    const fixtures = h.state.get("ControlledDocument");
    const first = await h.add("ControlAudit", { name: "First" });
    h.clock.advance(5000);
    await h.add("ControlAudit", { name: "Second" });
    h.reset();
    expect(h.state.get("ControlAudit")).toEqual([]);
    expect(h.state.get("ControlledDocument")).toEqual(fixtures);
    expect(h.clock.now().toISOString()).toBe("2026-01-01T09:00:00.000Z");
    expect(h.executions).toEqual([]);
    const repeated = await h.add("ControlAudit", { name: "Repeated" });
    expect(repeated.id).toBe(first.id);
    expect(repeated.id).toMatch(/^[A-F0-9]{32}$/u);
});

test("shared settings and per-test overrides create independent world clocks and ID sequences", async () => {
    await using project = await controlProject();
    const options = {
        cwd: project.cwd,
        clock: fixedClock("2026-02-01T00:00:00Z"),
        ids: seededIds("same"),
    };
    using first = await createHarness(options);
    using second = await createHarness(options);
    const left = await first.add("ControlAudit", { name: "Left" });
    const right = await second.add("ControlAudit", { name: "Right" });
    expect(left.id).toBe(right.id);
    first.clock.advance(1000);
    expect(second.clock.now().toISOString()).toBe("2026-02-01T00:00:00.000Z");
    first.reset();
    expect(second.state.get("ControlAudit")).toHaveLength(1);
    expect((await first.add("ControlAudit", { name: "Again" })).id).toBe(left.id);
    expect((await second.add("ControlAudit", { name: "Next" })).id).not.toBe(right.id);
});

test("report subscriptions do not consume entity IDs and invalid clock changes are atomic", async () => {
    await using project = await controlProject();
    using first = await createHarness({ cwd: project.cwd });
    using second = await createHarness({ cwd: project.cwd });
    using _observation = first.observe(() => {
        /* Observe without allocating business identities. */
    });
    await first.get("ControlledDocument");
    expect((await first.add("ControlAudit", { name: "Left" })).id).toBe(
        (await second.add("ControlAudit", { name: "Right" })).id,
    );
    const before = first.clock.now().toISOString();
    expect(() => first.clock.advance(-1)).toThrow();
    expect(() => first.clock.advance(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => first.clock.set("not a date")).toThrow();
    expect(first.clock.now().toISOString()).toBe(before);
    expect(() => fixedClock("2026-01-01T09:00:00")).toThrow("timezone");
    expect(() => seededIds("")).toThrow();
});

test("fixture IDs and original package IDs do not consume the business ID stream", async () => {
    const packaged = `<Item type="ControlAudit" action="add" id="PACKAGED_RECORD">
        <name>Packaged</name><created_on>2025-01-01T00:00:00</created_on></Item>`;
    await using project = await controlProject(packaged);
    using first = await createHarness({ cwd: project.cwd });
    await Bun.write(
        join(project.cwd, ".harness/fixtures/extra.ts"),
        `export default {
        ControlAudit: [{ name: "Extra fixture", created_on: "2025-01-01T00:00:00" }],
    };`,
    );
    using second = await createHarness({ cwd: project.cwd });

    expect(second.state.getOne("ControlAudit", { name: "Packaged" }).id).toBe("PACKAGED_RECORD");
    expect(second.state.get("ControlAudit")).toHaveLength(2);
    expect((await first.add("ControlAudit", { name: "First" })).id).toBe(
        (await second.add("ControlAudit", { name: "Second" })).id,
    );
});
