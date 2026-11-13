import { expect, test } from "bun:test";

import { createHarness, ExecutionOutcome } from "../src/index.js";
import { observingCSharp } from "./helpers/failed-context.js";
import type { MethodContextObservation } from "./helpers/failed-context.js";
import { referenceMethod, referenceProject } from "./helpers/references.js";

const invalidContexts = [
    {
        name: "unrepresentable XML",
        mutation: `var property = this.node.OwnerDocument.CreateElement("unmodeled");
            property.AppendChild(this.node.OwnerDocument.CreateElement("nested"));
            this.node.AppendChild(property);`,
        diagnostic: "requires one Item in nested property",
    },
    {
        name: "oversized payload",
        mutation: `this.setProperty("large", new string('x', 9 * 1024 * 1024));`,
        diagnostic: "message exceeds its byte limit",
    },
];

for (const { name, mutation, diagnostic } of invalidContexts) {
    test(`failure context reports ${name} explicitly and keeps the worker usable`, async () => {
        const failing = `${mutation} throw new Exception("Original rejection");`;
        const source =
            referenceMethod("InvalidFailureContext", failing) +
            referenceMethod("HealthyMethod", 'return this.getInnovator().newResult("Healthy");');
        await using project = await referenceProject(source);
        using h = await createHarness({ cwd: project.cwd, csharp: {} });
        const before = h.state.get("ReferenceRecord");
        let failure: unknown;

        try {
            await h.callMethod("InvalidFailureContext");
        } catch (error) {
            failure = error;
        }

        expect(failure).toBeInstanceOf(Error);
        expect(String(failure)).toContain("Original rejection");
        expect(String(failure)).toContain("Failed to synchronize Method input");
        expect(String(failure)).toContain(diagnostic);
        expect(h.state.get("ReferenceRecord")).toEqual(before);
        expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
        expect((await h.callMethod("HealthyMethod")).getResult()).toBe("Healthy");
        h.reset();
        expect((await h.callMethod("HealthyMethod")).getResult()).toBe("Healthy");
    }, 60_000);
}

test("a caught fatal callback still returns changed input and rejects with its original cause", async () => {
    const source = `try { this.getInnovator().applySQL("SELECT 1"); }
        catch (Exception) { this.setProperty("caught", "true"); }
        this.setProperty("name", "Attempted input");
        return this;`;
    await using project = await referenceProject(referenceMethod("CatchFatalCallback", source));
    const observations: MethodContextObservation[] = [];
    using h = await createHarness({ cwd: project.cwd, executors: [observingCSharp(observations)] });
    using other = await createHarness({ cwd: project.cwd, csharp: {} });
    const before = h.state.get("ReferenceRecord");

    await expect(h.callMethod("CatchFatalCallback", { name: "Original" })).rejects.toThrow(
        "SQL execution",
    );
    expect(observations[0]?.context.getProperty("name")).toBe("Attempted input");
    expect(observations[0]?.context.getProperty("caught")).toBe("true");
    expect(h.state.get("ReferenceRecord")).toEqual(before);
    expect(other.state.get("ReferenceRecord")).toEqual(before);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
}, 60_000);

test("large exception diagnostics are bounded explicitly without losing the source failure", async () => {
    const source = `this.setProperty("name", "Attempted input");
        throw new Exception("Source rejected: " + new string('x', 9 * 1024 * 1024));`;
    await using project = await referenceProject(referenceMethod("LargeFailure", source));
    const observations: MethodContextObservation[] = [];
    using h = await createHarness({ cwd: project.cwd, executors: [observingCSharp(observations)] });
    let failure: unknown;

    try {
        await h.callMethod("LargeFailure");
    } catch (error) {
        failure = error;
    }

    expect(String(failure)).toContain("Source rejected:");
    expect(String(failure)).toContain("[truncated]");
    expect(String(failure).length).toBeLessThan(17 * 1024);
    expect(observations[0]?.context.getProperty("name")).toBe("Attempted input");
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
}, 60_000);
