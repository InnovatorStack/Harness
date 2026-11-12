import { expect, test } from "bun:test";

import { createHarness } from "@innovatorstack/harness";

test("updates the seeded document and resets to its starting state", async () => {
    using harness = await createHarness();
    const document = await harness.getOne("ExampleDocument", { name: "Specification" });

    await harness.update(document, { remark: "Reviewed" });

    const saved = await harness.getOne("ExampleDocument", { name: "Specification" });
    expect(saved.properties.remark).toBe("Reviewed");

    harness.reset();
    expect(harness.executions).toEqual([]);

    const original = await harness.getOne("ExampleDocument", { name: "Specification" });
    expect(original.properties.remark).toBe("Original");
});
