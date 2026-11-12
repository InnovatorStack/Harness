import { expect, test } from "bun:test";

import {
    checkCompatibility,
    CompilationStatus,
    createHarness,
    ExecutionOutcome,
} from "../src/index.js";
import type { Item } from "../src/items/item.js";
import type { MethodServerEvent } from "../src/methods/types.js";
import { referenceLifecycle, referenceMethod, referenceProject } from "./helpers/references.js";
import { afterLock, lockDelegate, stateEvent, unlockDelegate } from "./helpers/state-events.js";

test("CSharpInOut lock and unlock delegate through Get before replacement response changes", async () => {
    const source =
        stateEvent("onLock", "ReplaceLock", lockDelegate) +
        stateEvent("onUnlock", "ReplaceUnlock", unlockDelegate) +
        stateEvent("onAfterLock", "AfterLock", afterLock);
    await using project = await referenceProject(source);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const parent = await h.getOne("ReferenceRecord", { name: "Parent" });
    const response = await h.applyAML(
        `<Item type="ReferenceRecord" action="lock" id="${parent.id}" />`,
    );
    const stored = h.state.getOne("ReferenceRecord", { id: parent.id });

    expect(response.getProperty("response_marker")).toBe("");
    expect(response.getProperty("replacement_marker")).toBe("source");
    expect(stored.properties.locked_by_id).toBe(
        h.state.getOne("User", { login_name: "reference_owner" }).id,
    );
    expect(stored.properties).not.toHaveProperty("response_marker");
    expect(h.executions.at(-1)?.truncated).toBe(false);
    const unlocked = await h.applyAML(
        `<Item type="ReferenceRecord" action="unlock" id="${parent.id}" />`,
    );

    expect(unlocked.node.properties.locked_by_id).toBeNull();
    const report = await checkCompatibility({
        cwd: project.cwd,
        csharp: {},
        compile: true,
        executions: h.executions,
    });

    for (const method of report.methods) {
        expect(method.compilation).toMatchObject({ status: CompilationStatus.Compiled });
    }

    expect(report.methods.every((method) => method.executed)).toBe(true);
}, 60_000);

test("a promotion replacement owns the request and suppresses ordinary transition processing", async () => {
    const source =
        referenceLifecycle +
        stateEvent(
            "onPromote",
            "ReplacePromotion",
            'return this.getInnovator().newResult("replacement");',
        ) +
        stateEvent(
            "onBeforePromote",
            "MustNotRun",
            'throw new Exception("The native action was replaced");',
        );
    await using project = await referenceProject(source);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const parent = await h.getOne("ReferenceRecord", { name: "Parent" });
    const response = await h.applyAML(
        `<Item type="ReferenceRecord" action="promoteItem" id="${parent.id}"><state>Floating</state></Item>`,
    );

    expect(response.getResult()).toBe("replacement");
    expect(h.state.getOne("ReferenceRecord", { id: parent.id }).properties.state).toBe("Fixed");
    expect(h.executions.at(-1)?.changes).toHaveLength(0);
}, 60_000);

test("CSharpInOut promotion delegates through the imported transition and normal event chain", async () => {
    const code = "//MethodTemplateName=CSharpInOut;\neventData.BasePromoteItem(outDom);";
    await using project = await referenceProject(
        referenceLifecycle + stateEvent("onPromote", "DelegatePromote", code),
    );
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const parent = await h.getOne("ReferenceRecord", { name: "Parent" });
    const response = await h.applyAML(
        `<Item type="ReferenceRecord" action="promoteItem" id="${parent.id}"><state>Floating</state></Item>`,
    );

    expect(response.node.properties.state).toBe("Floating");
    expect(h.state.getOne("ReferenceRecord", { id: parent.id }).properties.state).toBe("Floating");
}, 60_000);

test("a source failure after the native base lock rolls back its persisted lock", async () => {
    const code =
        '//MethodTemplateName=CSharpInOut;\neventData.BaseLockItem(outDom);\nthrow new Exception("Rejected after native lock");';
    await using project = await referenceProject(stateEvent("onLock", "RejectLock", code));
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const parent = await h.getOne("ReferenceRecord", { name: "Parent" });
    const before = h.state.get("ReferenceRecord");
    await expect(
        h.applyAML(`<Item type="ReferenceRecord" action="lock" id="${parent.id}" />`),
    ).rejects.toThrow("Rejected after native lock");

    expect(h.state.get("ReferenceRecord")).toEqual(before);
    expect(h.executions.at(-1)?.changes.some((change) => change.name === "lock")).toBe(true);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
}, 60_000);

test("explicit suppression skips optional replacement hooks while required bindings survive", async () => {
    const optional = stateEvent(
        "onLock",
        "OptionalLock",
        'throw new Exception("Optional lock must be skipped");',
    );
    await using project = await referenceProject(optional);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const parent = await h.getOne("ReferenceRecord", { name: "Parent" });
    const result = await h.applyAML(
        `<Item type="ReferenceRecord" action="lock" id="${parent.id}" serverEvents="0" />`,
    );

    expect(result.node.properties.locked_by_id).toBeString();
    expect(h.trace.some((event) => event.kind === "method" && event.name === "OptionalLock")).toBe(
        false,
    );
    const required =
        stateEvent("onLock", "RequiredLock", lockDelegate, true) +
        stateEvent(
            "onBeforeLock",
            "RequiredBefore",
            'this.setAttribute("checked", "1"); return this;',
            true,
        );
    await using other = await referenceProject(required);
    using requiredWorld = await createHarness({ cwd: other.cwd, csharp: {} });
    const target = await requiredWorld.getOne("ReferenceRecord", { name: "Parent" });
    const response = await requiredWorld.applyAML(
        `<Item type="ReferenceRecord" action="lock" id="${target.id}" serverEvents="0" />`,
    );

    expect(response.getProperty("replacement_marker")).toBe("source");
    expect(
        requiredWorld.trace.some(
            (event) => event.kind === "method" && event.name === "RequiredBefore",
        ),
    ).toBe(true);
}, 60_000);

test("implicit edit locks use the same replacement chain and unlock the new generation", async () => {
    const source =
        stateEvent("onLock", "ReplaceLock", lockDelegate) +
        stateEvent("onUnlock", "ReplaceUnlock", unlockDelegate);
    await using project = await referenceProject(source);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const parent = await h.getOne("ReferenceRecord", { name: "Parent" });
    const result = await h.update(parent, { name: "Edited" });

    expect(result.id).not.toBe(parent.id);
    expect(result.properties).toMatchObject({ name: "Edited", generation: 2, locked_by_id: null });
    expect(h.trace.filter((event) => event.kind === "method").map((event) => event.name)).toEqual([
        "ReplaceLock",
        "ReplaceUnlock",
    ]);
}, 60_000);

test("a retained base port expires and ordinary nested Methods never inherit it", async () => {
    const source =
        stateEvent("onLock", "CustomLock", "unused") + referenceMethod("Nested", "unused");
    await using project = await referenceProject(source);
    let retained: MethodServerEvent | undefined;
    let request: Item | undefined;
    using h = await createHarness({
        cwd: project.cwd,
        executors: [
            () => ({
                language: "C#",

                async execute(method, item, ports) {
                    if (method.name === "Nested") {
                        expect(ports.serverEvent).toBeUndefined();

                        return item;
                    }

                    retained = ports.serverEvent;
                    request = item.clone();
                    expect(retained?.name).toBe("onLock");
                    await ports.applyMethod("Nested", item);

                    if (!retained) {
                        throw new Error("The replacement must receive its base port.");
                    }

                    return await retained.applyBase(item);
                },
            }),
        ],
    });
    const parent = await h.getOne("ReferenceRecord", { name: "Parent" });
    await h.applyAML(`<Item type="ReferenceRecord" action="lock" id="${parent.id}" />`);

    if (!request) {
        throw new Error("The original request must have been captured.");
    }

    const saved = request;
    expect(() => retained?.applyBase(saved)).toThrow();
    h.reset();
    expect(() => retained?.applyBase(saved)).toThrow();
    expect(
        h.state.getOne("ReferenceRecord", { id: parent.id }).properties.locked_by_id,
    ).toBeUndefined();
});
