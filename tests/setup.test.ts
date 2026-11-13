import { expect, test } from "bun:test";

import { createHarness } from "../src/index.js";
import { SetupTiming } from "./helpers/setup-timing.js";

test("shared setup imports packages and fixtures before the test queries data", async () => {
    using timing = new SetupTiming();
    using world = await timing.phase("create harness", () => createHarness());

    const parent = await timing.phase("get parent", () =>
        world.getOne("TestNode", { name: "Parent" }),
    );
    const child = await timing.phase("get child", () =>
        world.getOne("TestNode", { name: "Child" }),
    );
    const links = await timing.phase("get relationships", () =>
        world.get("TestLink", { source_id: parent.id }),
    );

    expect(parent.properties.count).toBe(9);
    expect(child.properties.count).toBe(0);
    expect(links).toMatchObject([
        {
            properties: {
                related_id: child.id,
                source_name: "Parent",
                note: "Loaded during shared setup",
            },
        },
    ]);
});

test("changes use normal actions while reset restores the configured fixture state", async () => {
    using world = await createHarness();
    const parent = await world.getOne("TestNode", { name: "Parent" });

    await world.update(parent, { count: 10 });
    expect((await world.getOne("TestNode", { name: "Parent" })).properties.count).toBe(10);

    world.reset();
    expect((await world.getOne("TestNode", { name: "Parent" })).properties.count).toBe(9);
});

test("each configured world owns isolated fixture data", async () => {
    using first = await createHarness();
    using second = await createHarness();
    const original = await first.getOne("TestNode", { name: "Parent" });

    await first.update(original, { count: 100 });

    expect((await second.getOne("TestNode", { name: "Parent" })).properties.count).toBe(9);
});
