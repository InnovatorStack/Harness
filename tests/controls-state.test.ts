import { expect, test } from "bun:test";

import { createHarness } from "../src/index.js";
import { controlMethod, controlProject } from "./helpers/controls.js";

test("raw state reads automatic fixtures without executing imported get hooks", async () => {
    const source = `this.setProperty("item_number", "Hidden");
return this.getInnovator().newResult("Separate hook response");`;
    await using project = await controlProject(`${controlMethod("FilterGet", source)}
        <Item type="Server Event" action="add"><source_id>CONTROL_DOCUMENT</source_id>
        <related_id>CONTROL_FilterGet</related_id><server_event>onBeforeGet</server_event></Item>`);
    using h = await createHarness({
        cwd: project.cwd,
        csharp: {},
    });
    const count = h.executions.length;
    expect(h.state.get("ControlledDocument")).toHaveLength(2);
    expect(
        h.state.getOne("ControlledDocument", { item_number: "DOC-001" }).properties.description,
    ).toBe("Original");
    expect(h.executions).toHaveLength(count);
    expect(await h.get("ControlledDocument")).toEqual([]);
    expect(h.executions.at(-1)?.mocks).toEqual([]);
    expect(h.state.get("ControlledDocument")).toHaveLength(2);
}, 60_000);

test("raw state exposes history and returns deeply immutable detached records", async () => {
    await using project = await controlProject();
    using h = await createHarness({ cwd: project.cwd });
    const original = h.state.getOne("ControlledDocument", { item_number: "DOC-001" });
    const updated = await h.update(original, { description: "Changed" });
    const versions = h.state.get("ControlledDocument", { item_number: "DOC-001" });
    expect(versions).toHaveLength(2);
    expect(() => h.state.getOne("ControlledDocument", { item_number: "DOC-001" })).toThrow(
        "found 2",
    );
    expect(h.state.getOne("ControlledDocument", { id: updated.id }).properties.is_current).toBe(1);
    expect(h.state.getOne("ControlledDocument", { id: original.id }).properties.is_current).toBe(0);
    expect(Reflect.set(original.properties, "description", "Corrupt")).toBe(false);
    expect(Reflect.set(versions, "0", updated)).toBe(false);
    expect(original.properties.description).toBe("Original");
    expect(Object.isFrozen(versions[0]?.properties)).toBe(true);
});

test("state queries validate selectors and exact cardinality even for empty results", async () => {
    await using project = await controlProject();
    using h = await createHarness({ cwd: project.cwd });
    expect(() => h.state.get("MissingType")).toThrow("not imported");
    expect(() => h.state.get("ControlledDocument", { typo: "value" })).toThrow(
        "not a stored property",
    );
    expect(() => h.state.getOne("ControlledDocument", { item_number: "Missing" })).toThrow(
        "found 0",
    );
    expect(() => h.state.get("ControlAudit", { name: Number.NaN })).toThrow();
    const selector = {
        get name(): string {
            throw new Error("Do not execute this getter");
        },
    };
    expect(() => h.state.get("ControlAudit", selector)).toThrow("accessors");
    expect(() => {
        Reflect.apply(h.state.get.bind(h.state), h.state, [
            "ControlAudit",
            { name: { nested: "no" } },
        ]);
    }).toThrow("scalar");
});

test("retained state and clock handles reject access after world closure", async () => {
    await using project = await controlProject();
    const h = await createHarness({ cwd: project.cwd });
    const state = h.state;
    const clock = h.clock;
    h.close();
    expect(() => state.get("ControlledDocument")).toThrow("closed");
    expect(() => clock.now()).toThrow("closed");
    expect(() => clock.advance(1)).toThrow("closed");
    expect(() =>
        h.observe(() => {
            /* Closed worlds cannot acquire subscriptions. */
        }),
    ).toThrow("closed");
});
