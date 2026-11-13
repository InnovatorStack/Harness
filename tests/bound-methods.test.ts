import { expect, test } from "bun:test";

import { AuthorizationMode, createHarness, ExecutionOutcome } from "../src/index.js";
import { ServerEventVersion } from "../src/platform/events/types.js";
import { noPublisherGrant, restrictedMethod } from "./helpers/bound-methods.js";
import { referenceEvent, referenceProject } from "./helpers/references.js";
import { securityProject } from "./helpers/security.js";

const eventCases = [
    { event: "onBeforeUpdate", version: ServerEventVersion.Item, action: "edit" },
    { event: "onBeforeUpdate", version: ServerEventVersion.Collection, action: "edit" },
    { event: "onBeforeVersion", version: ServerEventVersion.Item, action: "edit" },
    { event: "onAfterVersion", version: ServerEventVersion.Item, action: "edit" },
    { event: "onAfterVersion", version: ServerEventVersion.Collection, action: "edit" },
    { event: "onAfterUpdate", version: ServerEventVersion.Item, action: "edit" },
    { event: "onAfterUpdate", version: ServerEventVersion.Collection, action: "edit" },
    { event: "onBeforeGet", version: ServerEventVersion.Item, action: "get" },
    { event: "onAfterGet", version: ServerEventVersion.Item, action: "get" },
    { event: "onBeforeAdd", version: ServerEventVersion.Item, action: "add" },
    { event: "onAfterAdd", version: ServerEventVersion.Item, action: "add" },
    { event: "onAfterAdd", version: ServerEventVersion.Collection, action: "add" },
    { event: "onBeforeDelete", version: ServerEventVersion.Item, action: "delete" },
    { event: "onAfterDelete", version: ServerEventVersion.Item, action: "delete" },
    { event: "onBeforeLock", version: ServerEventVersion.Item, action: "lock" },
    { event: "onAfterLock", version: ServerEventVersion.Item, action: "lock" },
    { event: "onBeforeUnlock", version: ServerEventVersion.Item, action: "unlock" },
    { event: "onAfterUnlock", version: ServerEventVersion.Item, action: "unlock" },
];

test.each(eventCases)(
    "bound Method execution skips its identity restriction: %j",
    async ({ event, version, action }) => {
        const source =
            restrictedMethod("RestrictedHook", `${noPublisherGrant} return this;`) +
            referenceEvent("SEC_DOCUMENT", event, "RestrictedHook", { version });
        await using project = await securityProject(source);
        using h = await createHarness({
            cwd: project.cwd,
            authorization: AuthorizationMode.Native,
            csharp: {},
        });
        const original = h.state.getOne("SecurityDocument", { name: "Editable" });

        if (action === "unlock") {
            await h.applyAML(`<Item type="SecurityDocument" action="lock" id="${original.id}" />`);
        }

        expect((await h.callMethod("RestrictedHook")).getErrorCode()).toBe("PermissionDenied");
        const selector = action === "add" ? "" : `id="${original.id}"`;
        const result = await h.applyAML(
            `<Item type="SecurityDocument" action="${action}" ${selector} />`,
        );
        const run = h.executions.at(-1);

        expect(result.isError()).toBe(false);
        expect(run?.outcome).toBe(ExecutionOutcome.Committed);
        expect(run?.mocks).toEqual([]);
        expect(
            h.trace.some((entry) => entry.kind === "execution" && entry.name === "RestrictedHook"),
        ).toBe(true);
        expect((await h.callMethod("RestrictedHook")).getErrorCode()).toBe("PermissionDenied");
        h.reset();
        expect((await h.callMethod("RestrictedHook")).getErrorCode()).toBe("PermissionDenied");
    },
    60_000,
);

test.each(["method", "aml"])(
    "native NoCheck is inherited by nested %s calls and expires with the hook",
    async (call) => {
        const nested =
            call === "method"
                ? 'this.getInnovator().applyMethod("NestedRestricted", "")'
                : 'this.getInnovator().applyAML(@"<Item type=""SecurityDocument"" action=""NestedRestricted"" />")';
        const source =
            restrictedMethod(
                "NestedRestricted",
                `${noPublisherGrant} return this.getInnovator().newResult("Nested source ran");`,
            ) +
            restrictedMethod(
                "RestrictedHook",
                `
            ${noPublisherGrant}
            var result = ${nested};
            if (result.isError()) { return result; }
            if (result.getResult() != "Nested source ran") { throw new Exception("Nested Method did not execute"); }
            this.setProperty("name", "Saved through NoCheck");
            return this;
        `,
            ) +
            referenceEvent("SEC_DOCUMENT", "onBeforeUpdate", "RestrictedHook");
        await using project = await securityProject(source);
        using h = await createHarness({
            cwd: project.cwd,
            authorization: AuthorizationMode.Native,
            csharp: {},
        });
        const original = h.state.getOne("SecurityDocument", { name: "Editable" });
        const result = await h.applyAML(
            `<Item type="SecurityDocument" action="edit" id="${original.id}" />`,
        );

        expect(result.getProperty("name")).toBe("Saved through NoCheck");
        expect(h.state.getOne("SecurityDocument", { id: result.getID() }).properties.name).toBe(
            "Saved through NoCheck",
        );
        expect((await h.callMethod("NestedRestricted")).getErrorCode()).toBe("PermissionDenied");
        expect((await h.callMethod("RestrictedHook")).getErrorCode()).toBe("PermissionDenied");
    },
    60_000,
);

test("NoCheck cannot edit protected records and a rejection rolls back earlier nested writes", async () => {
    const source =
        restrictedMethod(
            "RestrictedHook",
            `
        ${noPublisherGrant}
        var audit = this.newItem("SecurityDocument", "add");
        audit.setProperty("name", "Must roll back");
        var saved = audit.apply();
        if (saved.isError()) { return saved; }
        var target = this.newItem("SecurityDocument", "edit");
        target.setID(this.getProperty("target"));
        target.setProperty("name", "Forbidden update");
        return target.apply();
    `,
        ) + referenceEvent("SEC_DOCUMENT", "onBeforeUpdate", "RestrictedHook");
    await using project = await securityProject(source);
    using h = await createHarness({
        cwd: project.cwd,
        authorization: AuthorizationMode.Native,
        csharp: {},
    });
    const original = h.state.getOne("SecurityDocument", { name: "Editable" });
    const hidden = h.state.getOne("SecurityDocument", { name: "Hidden" });
    const baseline = h.state.get("SecurityDocument");
    const result =
        await h.applyAML(`<Item type="SecurityDocument" action="edit" id="${original.id}">
        <target>${hidden.id}</target></Item>`);

    expect(result.getErrorCode()).toBe("PermissionDenied");
    expect(h.state.get("SecurityDocument")).toEqual(baseline);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
    expect(
        h.trace.some((entry) => entry.kind === "execution" && entry.name === "RestrictedHook"),
    ).toBe(true);
    expect((await h.callMethod("RestrictedHook")).getErrorCode()).toBe("PermissionDenied");
}, 60_000);

test("bound mocks skip execution restrictions while direct mocked calls still require them", async () => {
    const source =
        restrictedMethod("RestrictedHook", "deliberately invalid source") +
        referenceEvent("SEC_DOCUMENT", "onAfterGet", "RestrictedHook");
    await using project = await securityProject(source);
    using h = await createHarness({
        cwd: project.cwd,
        authorization: AuthorizationMode.Native,
        csharp: false,
        mocks: [
            {
                method: "RestrictedHook",
                response: { aml: '<Item type="SecurityDocument"><name>Mocked view</name></Item>' },
            },
        ],
    });
    const result = await h.applyAML(
        '<Item type="SecurityDocument" action="get"><name>Editable</name></Item>',
    );

    expect(result.getProperty("name")).toBe("Editable");
    expect(h.executions.at(-1)?.mocks).toHaveLength(1);
    expect((await h.callMethod("RestrictedHook")).getErrorCode()).toBe("PermissionDenied");
    expect(h.executions.at(-1)?.mocks).toHaveLength(0);
});

test("custom authorization policies still observe and may reject bound Method calls", async () => {
    const source =
        restrictedMethod("RestrictedHook", "return this;") +
        referenceEvent("SEC_DOCUMENT", "onBeforeUpdate", "RestrictedHook");
    await using project = await securityProject(source);
    const observed: string[] = [];
    using h = await createHarness({
        cwd: project.cwd,
        csharp: false,

        authorization(request) {
            if (request.kind === "method") {
                observed.push(request.name);

                throw new Error("Custom policy rejected the Method");
            }
        },
    });
    const original = h.state.getOne("SecurityDocument", { name: "Editable" });
    const baseline = h.state.get("SecurityDocument");

    await expect(
        h.applyAML(`<Item type="SecurityDocument" action="edit" id="${original.id}" />`),
    ).rejects.toThrow("Custom policy rejected the Method");
    expect(observed).toEqual(["RestrictedHook"]);
    expect(h.state.get("SecurityDocument")).toEqual(baseline);
});

test("ordinary setup needs no authorization switch solely for a bound Method's restriction", async () => {
    const identity =
        '<Item type="Identity" action="add" id="SEC_PUBLISHERS"><name>Test publishers</name></Item>';
    const source =
        identity +
        restrictedMethod("RestrictedHook", 'this.setProperty("name", "Saved"); return this;') +
        referenceEvent("REF_HOLDER", "onBeforeUpdate", "RestrictedHook");
    await using project = await referenceProject(source, 'ReferenceHolder: [{ name: "Original" }]');
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const original = h.state.getOne("ReferenceHolder", { name: "Original" });
    const result = await h.applyAML(
        `<Item type="ReferenceHolder" action="update" id="${original.id}" />`,
    );

    expect(result.getProperty("name")).toBe("Saved");
    await expect(h.callMethod("RestrictedHook")).rejects.toMatchObject({
        code: "AuthorizationRequired",
    });
});

test.each([
    { event: "onLock", action: "lock", delegate: "BaseLockItem" },
    { event: "onUpdate", action: "edit", delegate: "BaseUpdateItem" },
])(
    "restricted replacement Methods may delegate without gaining an Identity: %j",
    async ({ event, action, delegate }) => {
        const source =
            restrictedMethod(
                "RestrictedReplacement",
                `
        // MethodTemplateName = CSharpInOut;
        ${noPublisherGrant}
        eventData.${delegate}(outDom);
    `,
            ) + referenceEvent("SEC_DOCUMENT", event, "RestrictedReplacement");
        await using project = await securityProject(source);
        using h = await createHarness({
            cwd: project.cwd,
            authorization: AuthorizationMode.Native,
            csharp: {},
        });
        const original = h.state.getOne("SecurityDocument", { name: "Editable" });
        const result = await h.applyAML(
            `<Item type="SecurityDocument" action="${action}" id="${original.id}" />`,
        );

        expect(result.isError()).toBe(false);
        expect(
            h.trace.some(
                (entry) => entry.kind === "execution" && entry.name === "RestrictedReplacement",
            ),
        ).toBe(true);
        expect((await h.callMethod("RestrictedReplacement")).getErrorCode()).toBe(
            "PermissionDenied",
        );
    },
);
