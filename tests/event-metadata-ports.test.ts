import { expect, test } from "bun:test";

import { createHarness, MethodEventDataKind } from "../src/index.js";
import type { MethodEventData } from "../src/index.js";
import { Item } from "../src/items/item.js";
import type { MethodExecutor } from "../src/methods/types.js";
import { ServerEventVersion } from "../src/platform/events/types.js";
import { referenceEvent, referenceMethod, referenceProject } from "./helpers/references.js";

interface ObservedMetadata {
    readonly method: string;
    readonly data: MethodEventData | undefined;
}

function executor(observed: ObservedMetadata[]): MethodExecutor {
    return {
        language: "C#",

        async execute(method, item, ports) {
            const data = ports.eventData;
            observed.push({ method: method.name, data });

            if (data?.kind === MethodEventDataKind.AfterVersion) {
                expect(Object.isFrozen(data)).toBe(true);
                expect(Object.isFrozen(data.oldIdsNewIdsMap)).toBe(true);
                expect(Reflect.set(data, "newItemId", "Changed")).toBe(false);
                expect(Reflect.set(data.oldIdsNewIdsMap, item.getID(), "Changed")).toBe(false);
                await ports.applyMethod("NestedMetadataCall", Item.create("Method"));
            }

            return item;
        },
    };
}

function portProject() {
    const methods = ["VersionMetadata", "UpdateMetadata", "NestedMetadataCall"]
        .map((name) => referenceMethod(name, "return this;"))
        .join("");

    return referenceProject(
        methods +
            referenceEvent("REF_RECORD", "onAfterVersion", "VersionMetadata") +
            referenceEvent("REF_RECORD", "onAfterUpdate", "UpdateMetadata", {
                version: ServerEventVersion.Collection,
            }),
    );
}

test("custom executors receive immutable metadata without passing it to nested ordinary Methods", async () => {
    await using project = await portProject();
    const observed: ObservedMetadata[] = [];
    using h = await createHarness({
        cwd: project.cwd,
        csharp: false,
        executors: [() => executor(observed)],
    });
    const parent = h.state.getOne("ReferenceRecord", { name: "Parent" });
    const result = await h.applyAML(
        `<Item type="ReferenceRecord" action="version" id="${parent.id}" />`,
    );

    expect(result.isError()).toBe(false);
    expect(observed.map((entry) => entry.method)).toEqual([
        "VersionMetadata",
        "NestedMetadataCall",
        "UpdateMetadata",
    ]);
    expect(observed[0]?.data).toEqual({
        kind: MethodEventDataKind.AfterVersion,
        typeId: h.state.getOne("ItemType", { name: "ReferenceRecord" }).id,
        newItemId: result.getID(),
        oldIdsNewIdsMap: { [parent.id]: result.getID() },
    });
    expect(observed[1]?.data).toBeUndefined();
    expect(observed[2]?.data).toMatchObject({
        kind: MethodEventDataKind.AfterUpdate,
        id: null,
        oldIdsNewIdsMap: { [parent.id]: result.getID() },
    });
});

test("retained metadata snapshots stay detached across world reset and another world", async () => {
    await using project = await portProject();
    const firstCalls: ObservedMetadata[] = [];
    const secondCalls: ObservedMetadata[] = [];
    using first = await createHarness({
        cwd: project.cwd,
        csharp: false,
        executors: [() => executor(firstCalls)],
    });
    using second = await createHarness({
        cwd: project.cwd,
        csharp: false,
        executors: [() => executor(secondCalls)],
    });
    const parent = first.state.getOne("ReferenceRecord", { name: "Parent" });
    const request = `<Item type="ReferenceRecord" action="version" id="${parent.id}" />`;
    const original = await first.applyAML(request);
    const snapshot = firstCalls[0]?.data;
    first.reset();
    const resetResult = await first.applyAML(request);
    const otherResult = await second.applyAML(request);

    expect(snapshot).toMatchObject({
        newItemId: original.getID(),
        oldIdsNewIdsMap: { [parent.id]: original.getID() },
    });
    expect(snapshot).not.toBe(firstCalls[3]?.data);
    expect(snapshot).not.toBe(secondCalls[0]?.data);
    expect(original.getID()).not.toBe(resetResult.getID());
    expect(original.getID()).not.toBe(otherResult.getID());
    expect(secondCalls[0]?.data).toMatchObject({ newItemId: otherResult.getID() });
});

test("mixed after bindings run in metadata order and share each Item context independently", async () => {
    const methods = ["FirstItemHook", "BatchHook", "SecondItemHook"]
        .map((name) => referenceMethod(name, "return this;"))
        .join("");
    const source =
        methods +
        referenceEvent("REF_RECORD", "onAfterUpdate", "FirstItemHook", { order: 10 }) +
        referenceEvent("REF_RECORD", "onAfterUpdate", "BatchHook", {
            version: ServerEventVersion.Collection,
            order: 20,
        }) +
        referenceEvent("REF_RECORD", "onAfterUpdate", "SecondItemHook", { order: 30 });
    await using project = await referenceProject(source);
    const calls: string[] = [];
    const extension: MethodExecutor = {
        language: "C#",

        async execute(method, item, ports) {
            calls.push(`${method.name}:${item.getID()}`);

            if (method.name === "FirstItemHook") {
                item.setProperty("name", "Pending context value");
            } else if (method.name === "SecondItemHook") {
                expect(item.getProperty("name")).toBe("Pending context value");
            } else {
                expect(item.getType()).toBe("");
                expect(ports.eventData?.kind).toBe(MethodEventDataKind.AfterUpdate);
            }

            return item;
        },
    };
    using h = await createHarness({
        cwd: project.cwd,
        csharp: false,
        executors: [() => extension],
    });
    const parent = h.state.getOne("ReferenceRecord", { name: "Parent" });
    const child = h.state.getOne("ReferenceRecord", { name: "Child" });
    const result = await h.applyAML(`<Item type="ReferenceRecord" action="edit"
        idlist="${parent.id},${child.id}"><name>Saved</name></Item>`);
    const ids = result.payload.items.map((node) => node.attributes.id);

    expect(calls).toEqual([
        `FirstItemHook:${ids[0]}`,
        `FirstItemHook:${ids[1]}`,
        "BatchHook:",
        `SecondItemHook:${ids[0]}`,
        `SecondItemHook:${ids[1]}`,
    ]);
    expect(h.state.get("ReferenceRecord", { name: "Saved" })).toHaveLength(2);
    expect(h.state.get("ReferenceRecord", { name: "Pending context value" })).toEqual([]);
});
