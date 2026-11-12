import { expect, test } from "bun:test";

import { CapabilityId, checkCompatibility, createHarness } from "../src/index.js";
import { ServerEventVersion } from "../src/platform/events/types.js";
import { referenceEvent, referenceMethod, referenceProject } from "./helpers/references.js";

const base = `<Item type="ItemType" action="add" id="EVENT_BASE"><name>EventBase</name><implementation_type>polymorphic</implementation_type></Item>
    <Item type="Morphae" action="add"><source_id>EVENT_BASE</source_id><related_id>REF_HOLDER</related_id></Item>`;
const holders = 'ReferenceHolder: [{ name: "First" }, { name: "Second" }]';

test("polymorphic base events run in metadata order with concrete item and collection contexts", async () => {
    const source =
        base +
        referenceMethod(
            "InheritedBefore",
            `
        if (this.getType() != "ReferenceHolder") throw new Exception("Wrong inherited context type");
        this.setProperty("name", "Inherited");
        return this;
    `,
        ) +
        referenceEvent("EVENT_BASE", "onBeforeUpdate", "InheritedBefore", { order: 10 }) +
        referenceMethod(
            "ConcreteBefore",
            `
        if (this.getProperty("name") != "Inherited") throw new Exception("Wrong event order");
        this.setProperty("name", "Concrete");
        return this;
    `,
        ) +
        referenceEvent("REF_HOLDER", "onBeforeUpdate", "ConcreteBefore", { order: 20 }) +
        referenceMethod(
            "InheritedCollection",
            `
        if (this.getType() != "" || eventData.NewItemsIds.Count() != 2) throw new Exception("Wrong inherited batch metadata");
        var type = this.newItem("ItemType", "get");
        type.setID(eventData.TypeId);
        if (type.apply().getProperty("name") != "ReferenceHolder") throw new Exception("Polymorphic type leaked into metadata");
        return this;
    `,
        ) +
        referenceEvent("EVENT_BASE", "onAfterUpdate", "InheritedCollection", {
            version: ServerEventVersion.Collection,
        });
    await using project = await referenceProject(source, holders);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const result = await h.applyAML(`<Item type="ReferenceHolder" action="update"
        where="name IN ('First', 'Second')"><name>Requested</name></Item>`);

    expect(result.getItemCount()).toBe(2);
    expect(h.state.get("ReferenceHolder", { name: "Concrete" })).toHaveLength(2);
    expect(h.trace.filter((event) => event.kind === "method").map((event) => event.name)).toEqual([
        "InheritedBefore",
        "ConcreteBefore",
        "InheritedBefore",
        "ConcreteBefore",
        "InheritedCollection",
    ]);
}, 60_000);

test("inherited ordering conflicts are detected by preflight and the same runtime planner", async () => {
    const source =
        base +
        referenceMethod("BaseHook", "return this;") +
        referenceMethod("OwnHook", "return this;") +
        referenceEvent("EVENT_BASE", "onBeforeGet", "BaseHook", { order: 10 }) +
        referenceEvent("REF_HOLDER", "onBeforeGet", "OwnHook", { order: 10 });
    await using project = await referenceProject(source, holders);
    const report = await checkCompatibility({ cwd: project.cwd });
    const issue = report.issues.find((issue) => issue.causeCode === "AmbiguousEventOrder");

    expect(issue?.capability).toBe(CapabilityId.ServerEvents);
    using h = await createHarness({ cwd: project.cwd });
    await expect(h.get("ReferenceHolder")).rejects.toThrow("same sort order");
});

test("cyclic inherited metadata fails before any Method is executed", async () => {
    const graph = `${base}<Item type="ItemType" action="add" id="EVENT_OTHER"><name>EventOther</name><implementation_type>polymorphic</implementation_type></Item>
        <Item type="Morphae" action="add"><source_id>EVENT_BASE</source_id><related_id>EVENT_OTHER</related_id></Item>
        <Item type="Morphae" action="add"><source_id>EVENT_OTHER</source_id><related_id>EVENT_BASE</related_id></Item>`;
    const source =
        graph +
        referenceMethod("NeverCalled", 'throw new Exception("Inheritance cycle was ignored");') +
        referenceEvent("EVENT_BASE", "onBeforeGet", "NeverCalled");
    await using project = await referenceProject(source, holders);
    const report = await checkCompatibility({ cwd: project.cwd });

    expect(report.issues.some((issue) => issue.causeCode === "EventInheritanceCycle")).toBe(true);
    using h = await createHarness({ cwd: project.cwd });
    await expect(h.get("ReferenceHolder")).rejects.toThrow("Cyclic Morphae");
    expect(h.trace.filter((event) => event.kind === "method")).toHaveLength(0);
});

test("a shared ancestor is invoked once through a diamond and remains isolated across resets", async () => {
    const graph = `${base}
        <Item type="ItemType" action="add" id="EVENT_LEFT"><name>EventLeft</name><implementation_type>polymorphic</implementation_type></Item>
        <Item type="ItemType" action="add" id="EVENT_RIGHT"><name>EventRight</name><implementation_type>polymorphic</implementation_type></Item>
        <Item type="Morphae" action="add"><source_id>EVENT_BASE</source_id><related_id>EVENT_LEFT</related_id></Item>
        <Item type="Morphae" action="add"><source_id>EVENT_BASE</source_id><related_id>EVENT_RIGHT</related_id></Item>
        <Item type="Morphae" action="add"><source_id>EVENT_LEFT</source_id><related_id>REF_HOLDER</related_id></Item>
        <Item type="Morphae" action="add"><source_id>EVENT_RIGHT</source_id><related_id>REF_HOLDER</related_id></Item>`;
    const source =
        graph +
        referenceMethod("RootOnce", "return this;") +
        referenceEvent("EVENT_BASE", "onAfterUpdate", "RootOnce", {
            version: ServerEventVersion.Collection,
            required: true,
        });
    await using project = await referenceProject(source, holders);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });

    for (let attempt = 0; attempt < 2; attempt += 1) {
        if (attempt > 0) {
            h.reset();
        }

        const result =
            await h.applyAML(`<Item type="ReferenceHolder" action="update" serverEvents="0"
            where="name IN ('First', 'Second')"><name>Changed</name></Item>`);
        expect(result.getItemCount()).toBe(2);
        expect(
            h.trace.filter((event) => event.kind === "method").map((event) => event.name),
        ).toEqual(["RootOnce"]);
    }
}, 60_000);

test("a concrete Morphae owner is rejected with its source location before Method execution", async () => {
    const graph = `<Item type="Morphae" action="add"><source_id>REF_RECORD</source_id><related_id>REF_HOLDER</related_id></Item>`;
    const source =
        graph +
        referenceMethod("InvalidOwner", "return this;") +
        referenceEvent("REF_RECORD", "onBeforeGet", "InvalidOwner");
    await using project = await referenceProject(source, holders);
    const report = await checkCompatibility({ cwd: project.cwd });
    const issue = report.issues.find((issue) => issue.causeCode === "InvalidEventInheritance");

    expect(issue?.source?.file).toEndWith("source.xml");
    expect(issue?.capability).toBe(CapabilityId.ServerEvents);
    using h = await createHarness({ cwd: project.cwd });
    await expect(h.get("ReferenceHolder")).rejects.toThrow("polymorphic ItemType");
    expect(h.trace.filter((event) => event.kind === "method")).toHaveLength(0);
});
