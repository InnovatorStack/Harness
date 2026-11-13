import { expect, test } from "bun:test";

import { createHarness, ExecutionOutcome } from "../src/index.js";
import {
    failedVersionSources,
    inspectFailedBase,
    observingCSharp,
} from "./helpers/failed-context.js";
import type { MethodContextObservation } from "./helpers/failed-context.js";
import { referenceMethod, referenceProject } from "./helpers/references.js";

const profiles: readonly { readonly failure: "return" | "throw"; readonly separate: boolean }[] = [
    { failure: "return", separate: false },
    { failure: "throw", separate: false },
    { failure: "return", separate: true },
    { failure: "throw", separate: true },
];

test.each(profiles)(
    "failed before-version Methods retain their pending input while stored state rolls back: %j",
    async ({ failure, separate }) => {
        await using project = await referenceProject(failedVersionSources(failure, separate));
        const observations: MethodContextObservation[] = [];
        using h = await createHarness({
            cwd: project.cwd,
            executors: [observingCSharp(observations)],
        });
        const parent = await h.getOne("ReferenceRecord", { name: "Parent" });
        const before = h.state.get("ReferenceRecord");

        await expect(h.update(parent, { name: "Requested" })).rejects.toThrow(
            "Version hook rejected",
        );
        expect(h.state.get("ReferenceRecord")).toEqual(before);
        expect(h.state.get("ReferenceHolder")).toEqual([]);
        expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
        expect(h.executions.at(-1)?.mocks).toEqual([]);
        const caller = observations.find((entry) => entry.method === "InspectFailedBase");

        expect(caller?.context.getProperty("caller_verified")).toBe("true");
        expect(caller?.context.getProperty("name")).toBe("Hook mutation");
        expect(caller?.context.getProperty("rejection_marker")).toBe("Rejected later");
        expect(h.state.getOne("Method", { name: "InspectFailedBase" }).properties.method_code).toBe(
            inspectFailedBase,
        );
    },
    60_000,
);

test("a throwing Method returns its attempted context to the executor without persisting request fields", async () => {
    const source =
        'this.setProperty("name", "Attempted input"); throw new Exception("Source failed");';
    await using project = await referenceProject(referenceMethod("MutateAndThrow", source));
    const observations: MethodContextObservation[] = [];
    using h = await createHarness({ cwd: project.cwd, executors: [observingCSharp(observations)] });
    const before = h.state.get("ReferenceRecord");

    await expect(h.callMethod("MutateAndThrow", { name: "Original input" })).rejects.toThrow(
        "Source failed",
    );
    expect(observations[0]?.context.getProperty("name")).toBe("Attempted input");
    expect(h.state.get("ReferenceRecord")).toEqual(before);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
}, 60_000);

test.each(["id", "idlist", "where"])(
    "a rejected batch retains its last source ID and removes normalized selectors: %s",
    async (selector) => {
        await using project = await referenceProject(failedVersionSources("throw", true));
        const observations: MethodContextObservation[] = [];
        using h = await createHarness({
            cwd: project.cwd,
            executors: [observingCSharp(observations)],
        });
        const parent = h.state.getOne("ReferenceRecord", { name: "Parent" });
        const child = h.state.getOne("ReferenceRecord", { name: "Child" });
        const before = h.state.get("ReferenceRecord");
        let criteria = `id="${parent.id}"`;

        if (selector === "idlist") {
            criteria = `idlist="${child.id},${parent.id}"`;
        } else if (selector === "where") {
            criteria = "where=\"name IN ('Parent', 'Child')\" orderBy=\"name\"";
        }

        await expect(
            h.applyAML(`<Item type="ReferenceRecord" action="edit" ${criteria}>
            <name>Requested</name><reject_at>${parent.id}</reject_at></Item>`),
        ).rejects.toThrow("Version hook rejected");
        const caller = observations.find((entry) => entry.method === "InspectFailedBase");
        const rejected = observations.filter((entry) => entry.method === "RejectVersion");

        expect(caller?.context.getProperty("caller_verified")).toBe("true");
        expect(caller?.context.getID()).toBe(parent.id);
        expect(rejected.map((entry) => entry.context.getID())).toEqual(
            selector === "id" ? [parent.id] : [child.id, parent.id],
        );
        expect(h.state.get("ReferenceRecord")).toEqual(before);
        expect(h.state.get("ReferenceHolder")).toEqual([]);
        expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
    },
    60_000,
);
