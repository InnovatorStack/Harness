import { expect, spyOn, test } from "bun:test";

import type { EngineImage } from "../src/engine/instance.js";
import { SetupCache } from "../src/harness/setup-cache.js";
import { createHarness, fixedClock, seededIds } from "../src/index.js";
import { PackageImporter } from "../src/packages/importer.js";
import { referenceProject } from "./helpers/references.js";

test("ordinary worlds import once and copy the configured state before application writes", async () => {
    await using project = await referenceProject();
    const imports = spyOn(PackageImporter.prototype, "import");

    try {
        const options = {
            cwd: project.cwd,
            ids: seededIds("setup-copy"),
            clock: fixedClock("2026-01-01T00:00:00Z"),
        };
        using first = await createHarness(options);
        const initial = first.state.getOne("ReferenceRecord", { name: "Parent" });
        const created = await first.add("ReferenceRecord", { name: "Local" });
        await first.update(initial, { name: "Changed" });
        first.clock.advance(60_000);
        using second = await createHarness(options);

        expect(imports.mock.calls.filter(([documents]) => documents.length > 0)).toHaveLength(1);
        expect(second.state.getOne("ReferenceRecord", { name: "Parent" })).toEqual(initial);
        expect(second.state.get("ReferenceRecord", { name: "Changed" })).toEqual([]);
        expect(second.state.get("ReferenceRecord", { name: "Local" })).toEqual([]);
        expect(second.clock.now().toISOString()).toBe("2026-01-01T00:00:00.000Z");
        expect((await second.add("ReferenceRecord", { name: "Second local" })).id).toBe(created.id);
        second.reset();
        expect(second.state.get("ReferenceRecord", { name: "Second local" })).toEqual([]);
        expect(first.state.get("ReferenceRecord", { name: "Changed" })).toHaveLength(1);
    } finally {
        imports.mockRestore();
    }
});

test("per-test mocks reuse setup while responses and execution reports remain local", async () => {
    await using project = await referenceProject();
    const imports = spyOn(PackageImporter.prototype, "import");

    try {
        using first = await createHarness({
            cwd: project.cwd,
            mocks: [{ method: "MockOnly", response: { text: "First" } }],
        });
        using second = await createHarness({
            cwd: project.cwd,
            mocks: [{ method: "MockOnly", response: { text: "Second" } }],
        });
        expect((await first.callMethod("MockOnly")).getResult()).toBe("First");
        expect(second.executions).toEqual([]);
        expect((await second.callMethod("MockOnly")).getResult()).toBe("Second");
        expect(first.executions).toHaveLength(1);
        expect(second.executions).toHaveLength(1);
        expect(imports.mock.calls.filter(([documents]) => documents.length > 0)).toHaveLength(1);
    } finally {
        imports.mockRestore();
    }
});

test("concurrent creation prepares one image and returns independent live worlds", async () => {
    await using project = await referenceProject();
    const imports = spyOn(PackageImporter.prototype, "import");
    const worlds = await Promise.all([
        createHarness({ cwd: project.cwd }),
        createHarness({ cwd: project.cwd }),
    ]);

    try {
        expect(imports.mock.calls.filter(([documents]) => documents.length > 0)).toHaveLength(1);
        expect(worlds).toHaveLength(2);
        const [first, second] = worlds;

        await first.add("ReferenceRecord", { name: "Only first" });
        expect(second.state.get("ReferenceRecord", { name: "Only first" })).toEqual([]);
    } finally {
        for (const world of worlds) {
            world.close();
        }

        imports.mockRestore();
    }
});

test("image retention evicts old setups instead of retaining one database per test", () => {
    const cache = new SetupCache();
    const image: EngineImage = {
        database: new Uint8Array(1),
        values: { clock: undefined, ids: { fixtures: 0, items: 0 } },
    };
    cache.put("original", image);

    for (let index = 0; index < 500; index += 1) {
        cache.put(String(index), image);
    }

    expect(cache.get("original")).toBeUndefined();
    expect(cache.get("495")).toBeUndefined();
    expect(cache.get("499")).toBe(image);
});

test("different setups copy the built-in import view before applying local changes", async () => {
    await using project = await referenceProject();
    using first = await createHarness({ cwd: project.cwd, ids: seededIds("first") });
    const world = await first.getOne("Identity", { name: "World" });
    await first.update(world, { name: "Only first" });

    using second = await createHarness({ cwd: project.cwd, ids: seededIds("second") });
    expect((await second.getOne("Identity", { name: "World" })).id).toBe(world.id);
    expect(await second.get("Identity", { name: "Only first" })).toEqual([]);
    expect((await first.getOne("Identity", { id: world.id })).properties.name).toBe("Only first");
});
