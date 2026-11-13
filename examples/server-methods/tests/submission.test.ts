import { expect, test } from "bun:test";

import { createHarness, FailurePoint, ItemAction, MethodSourceKind } from "@innovatorstack/harness";

test("an incomplete review saves its remark while preserving its approval date", async () => {
    using harness = await createHarness();
    const before = await harness.getOne("ExampleReview", { name: "Incomplete review" });

    const response = await harness.callMethod("SubmitReview", {
        review_id: before.id,
        remark: "A permitted change",
        approved_on: "2026-02-01T00:00:00",
    });

    expect(response.isError()).toBe(false);
    const after = await harness.getOne("ExampleReview", { name: "Incomplete review" });
    expect(after.properties.remark).toBe("A permitted change");
    expect(after.properties.approved_on).toBe(before.properties.approved_on);

    const methods = harness.trace.filter((event) => event.kind === "method");
    expect(methods.map((event) => event.name)).toContain("SubmitReview");
    expect(methods.map((event) => event.name)).toContain("GuardReview");
    const submit = methods.find((event) => event.name === "SubmitReview");
    expect(submit?.methodSource?.kind).toBe(MethodSourceKind.LocalFile);
    expect(submit?.methodSource?.fallback).toBe(false);
});

test("a complete review accepts its approval date", async () => {
    using harness = await createHarness();
    const before = await harness.getOne("ExampleReview", { name: "Complete review" });

    const response = await harness.callMethod("SubmitReview", {
        review_id: before.id,
        remark: "Approved",
        approved_on: "2026-02-01T00:00:00",
    });

    expect(response.isError()).toBe(false);
    const after = await harness.getOne("ExampleReview", { name: "Complete review" });
    expect(after.properties.approved_on).toBe("2026-02-01T00:00:00");
});

test("a failed update rolls back its stored changes", async () => {
    using harness = await createHarness();
    const before = await harness.getOne("ExampleReview", { name: "Complete review" });
    using failure = harness.injectFailure({
        type: "ExampleReview",
        action: ItemAction.Edit,
        at: FailurePoint.AfterCall,
        error: new Error("The save failed"),
    });

    await expect(
        harness.callMethod("SubmitReview", {
            review_id: before.id,
            remark: "Must roll back",
            approved_on: "2026-02-01T00:00:00",
        }),
    ).rejects.toThrow("The save failed");

    expect(failure.triggered).toBe(true);
    expect(await harness.getOne("ExampleReview", { name: "Complete review" })).toEqual(before);
});
