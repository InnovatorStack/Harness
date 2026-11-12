import { expect, test } from "bun:test";

import { createHarness, fixedClock, seededIds } from "../src/index.js";
import type { HarnessOptions } from "../src/index.js";
import { controlProject } from "./helpers/controls.js";

function ignoreExecution(): void {
    // A subscriber with no business effects is sufficient for registration-limit tests.
}

test("invalid failure definitions fail at registration without installing partial rules", async () => {
    await using project = await controlProject();
    using h = await createHarness({ cwd: project.cwd });
    const error = new Error("Invalid injection definition");
    const invalid: readonly unknown[] = [
        { method: "Submit", error: "not an Error" },
        { method: "Submit", error, occurrence: 0 },
        { method: "Submit", error, occurrence: 1.5 },
        { method: "Submit", error, at: "arbitrary" },
        { method: "Submit", sql: true, error },
        { type: "ControlAudit", action: "arbitrary", error },
        { sql: true, when: "not an object", error },
        { sql: true, when: { nested: [] }, error },
        { method: "", error },
        { method: "Submit", unknown: true, error },
    ];

    for (const definition of invalid) {
        expect(() => {
            Reflect.apply(h.injectFailure.bind(h), h, [definition]);
        }).toThrow();
    }

    await h.add("ControlAudit", { name: "Unintercepted" });
    expect(h.executions.at(-1)?.failures).toEqual([]);
});

test("subscription and failure limits reject excess registrations and disposal releases capacity", async () => {
    await using project = await controlProject();
    using h = await createHarness({ cwd: project.cwd });
    const observations = Array.from({ length: 128 }, () => h.observe(ignoreExecution));
    expect(() => h.observe(ignoreExecution)).toThrow("observer limit");

    for (const observation of observations) {
        observation[Symbol.dispose]();
    }

    using _observation = h.observe(ignoreExecution);
    const failures = Array.from({ length: 128 }, (_, index) =>
        h.injectFailure({
            method: `Unused${index}`,
            error: new Error("Unused failure"),
        }),
    );
    expect(() => h.injectFailure({ method: "Overflow", error: new Error("Overflow") })).toThrow(
        "failure-injection limit",
    );

    for (const failure of failures) {
        failure[Symbol.dispose]();
    }

    using _failure = h.injectFailure({ method: "AvailableAgain", error: new Error("Unused") });
    await h.add("ControlAudit", { name: "Unaffected" });
});

test("unconfigured worlds use host time and random IDs and reset restores the system clock", async () => {
    await using project = await controlProject();
    const options: HarnessOptions = { cwd: project.cwd, config: { csharp: false } };
    using first = await createHarness(options);
    using second = await createHarness(options);
    const before = Date.now();
    const now = first.clock.now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
    expect((await first.add("ControlAudit", { name: "First" })).id).not.toBe(
        (await second.add("ControlAudit", { name: "Second" })).id,
    );
    first.clock.set("2001-01-01T00:00:00Z");
    first.reset();
    expect(first.clock.now().getTime()).toBeGreaterThanOrEqual(before);

    expect(() => fixedClock(new Date(Number.NaN))).toThrow();
    expect(() => seededIds("a".repeat(1025))).toThrow();
});
