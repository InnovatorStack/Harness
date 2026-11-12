import { expect, test } from "bun:test";
import { join } from "node:path";

import { createEngine } from "../src/engine.js";
import { AuthorizationMode, createHarness, ExecutionOutcome } from "../src/index.js";
import { classificationProject } from "./helpers/classifications.js";
import { referenceEvent, referenceMethod } from "./helpers/references.js";

test.each([false, true])(
    "Update rights cannot enter a class without Can Add: versionable=%s",
    async (versionable) => {
        await using project = await classificationProject("", { versionable });
        using h = await createHarness({
            cwd: project.cwd,
            authorization: AuthorizationMode.Native,
        });
        const original = await h.getOne("ClassificationRecord", { name: "Start" });
        const before = h.state.get("ClassificationRecord");
        const links = h.state.get("ClassificationLink");
        const result = await h.applyAML(
            `<Item type="ClassificationRecord" action="edit" id="${original.id}">
            <classification>Restricted</classification><name>Must roll back</name>
        </Item>`,
        );

        expect(result.getErrorCode()).toBe("PermissionDenied");
        expect(h.state.get("ClassificationRecord")).toEqual(before);
        expect(h.state.get("ClassificationLink")).toEqual(links);
        expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
    },
);

test("resubmitting an unchanged class does not require creation rights", async () => {
    await using project = await classificationProject("", { versionable: true });
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });
    const legacy = await h.getOne("ClassificationRecord", { name: "Legacy" });
    const changed = await h.update(legacy, { classification: "Legacy", name: "Permitted update" });

    expect(changed.properties).toMatchObject({
        classification: "Legacy",
        name: "Permitted update",
        generation: 2,
    });
    await expect(h.add("ClassificationRecord", { classification: "Legacy" })).rejects.toThrow(
        "Cannot add",
    );
});

test("omitting classification preserves an old value that is no longer declared", async () => {
    const fixtures =
        'ClassificationRecord: [{ name: "Old data", classification: "Retired", permission_id: { name: "SEC_EDIT" } }],';
    await using project = await classificationProject("", { versionable: true, fixtures });
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });
    const original = await h.getOne("ClassificationRecord", { name: "Old data" });
    const changed = await h.update(original, { name: "Saved without assigning a class" });

    expect(changed.id).not.toBe(original.id);
    expect(changed.properties.classification).toBe("Retired");
    await expect(h.update(changed, { classification: "Retired" })).rejects.toThrow(
        "Invalid classification",
    );
});

test.each([AuthorizationMode.Native, AuthorizationMode.Unchecked])(
    "branch and unknown classes are invalid in %s mode",
    async (authorization) => {
        await using project = await classificationProject();
        using h = await createHarness({ cwd: project.cwd, authorization });
        const original = await h.getOne("ClassificationRecord", { name: "Start" });
        const before = h.state.get("ClassificationRecord");

        for (const classification of ["Design", "Design/Unknown", "design/Mechanical"]) {
            const added = await h.applyAML(
                `<Item type="ClassificationRecord" action="add"><classification>${classification}</classification></Item>`,
            );
            const edited = await h.applyAML(
                `<Item type="ClassificationRecord" action="edit" id="${original.id}"><classification>${classification}</classification></Item>`,
            );

            expect(added.getErrorCode()).toBe("InvalidClassification");
            expect(edited.getErrorCode()).toBe("InvalidClassification");
            expect(h.state.get("ClassificationRecord")).toEqual(before);
        }
    },
);

test("a before-update Method cannot redirect an allowed class into a forbidden class", async () => {
    const source =
        referenceMethod(
            "RedirectClass",
            'this.setProperty("classification", "Restricted"); return this;',
        ) + referenceEvent("CLASS_RECORD", "onBeforeUpdate", "RedirectClass");
    await using project = await classificationProject(source, { versionable: true });
    using h = await createHarness({
        cwd: project.cwd,
        authorization: AuthorizationMode.Native,
        csharp: {},
    });
    const original = h.state.getOne("ClassificationRecord", { name: "Start" });
    const before = h.state.get("ClassificationRecord");
    const result = await h.applyAML(
        `<Item type="ClassificationRecord" action="edit" id="${original.id}"><classification>Design/Electrical</classification></Item>`,
    );

    expect(result.getErrorCode()).toBe("PermissionDenied");
    expect(h.state.get("ClassificationRecord")).toEqual(before);
    expect(h.trace.some((entry) => entry.kind === "method" && entry.name === "RedirectClass")).toBe(
        true,
    );
}, 60_000);

test("a version hook cannot enter a class without its creation grant", async () => {
    const source =
        referenceMethod(
            "RedirectVersionClass",
            'this.setProperty("classification", "Restricted"); return this;',
        ) + referenceEvent("CLASS_RECORD", "onBeforeVersion", "RedirectVersionClass");
    await using project = await classificationProject(source, { versionable: true });
    using h = await createHarness({
        cwd: project.cwd,
        authorization: AuthorizationMode.Native,
        csharp: {},
    });
    const original = h.state.getOne("ClassificationRecord", { name: "Start" });
    const before = h.state.get("ClassificationRecord");
    const result = await h.applyAML(
        `<Item type="ClassificationRecord" action="edit" id="${original.id}"><name>Must roll back</name></Item>`,
    );

    expect(result.getErrorCode()).toBe("PermissionDenied");
    expect(h.state.get("ClassificationRecord")).toEqual(before);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
}, 60_000);

test("an inherited relationship can change class through copied Update rights", async () => {
    await using project = await classificationProject();
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });
    const original = await h.getOne("ClassificationLink", { name: "Owned" });
    const changed = await h.update(original, { classification: "Alternate" });

    expect(changed.properties).toMatchObject({
        classification: "Alternate",
        permission_id: "SEC_EDIT",
    });
});

test("a real C# grant permits reclassification and expires when the source Method finishes", async () => {
    const source = referenceMethod(
        "ReclassifyWithGrant",
        `
        var identity = Aras.Server.Security.Identity.GetByName("Test publishers");
        using (CCO.Permissions.GrantIdentity(identity)) {
            var item = this.newItem("ClassificationRecord", "edit");
            item.setID(this.getProperty("record"));
            item.setProperty("classification", "Restricted");
            return item.apply();
        }
    `,
    );
    await using project = await classificationProject(source, { versionable: true });
    using h = await createHarness({
        cwd: project.cwd,
        authorization: AuthorizationMode.Native,
        csharp: {},
    });
    const original = h.state.getOne("ClassificationRecord", { name: "Start" });
    const result = await h.callMethod("ReclassifyWithGrant", { record: original.id });

    expect(result.isError()).toBe(false);
    expect(result.getID()).not.toBe(original.id);
    expect(result.getProperty("classification")).toBe("Restricted");
    expect(result.getProperty("state")).toBe("Operations draft");
    expect(h.executions.at(-1)?.mocks).toEqual([]);
    await expect(h.add("ClassificationRecord", { classification: "Restricted" })).rejects.toThrow(
        "Cannot add",
    );
}, 60_000);

test("remapping an unchanged class still requires Change Access when its state Permission changes", async () => {
    const extra = `<Item type="Access" action="add"><source_id>SEC_EDIT</source_id>
        <related_id>A73B655731924CD0B027E4F4D5FCC0A9</related_id><can_get>1</can_get><can_update>1</can_update>
    </Item><Item type="Can Add" action="add"><source_id>CLASS_RECORD</source_id>
        <related_id>A73B655731924CD0B027E4F4D5FCC0A9</related_id><can_add>1</can_add><class_path>Design</class_path>
    </Item>`;
    await using project = await classificationProject(extra, { permission: "SEC_READ" });
    let actor = "";
    using engine = createEngine({
        authorization: AuthorizationMode.Native,

        userId: () => actor,
    });
    const user = engine.storage
        .listItems("User")
        .find((item) => item.properties.login_name === "admin");

    if (!user) {
        throw new Error("The baseline must provide its administrator User.");
    }

    actor = user.id;
    await engine.loadPackages([join(project.cwd, ".harness/packages/source.xml")]);
    const original = engine.seed("ClassificationRecord", {
        name: "Original",
        classification: "Design/Mechanical",
        permission_id: "SEC_EDIT",
    });
    const binding = engine.storage
        .listCatalogEntries("ItemType Life Cycle")
        .find(
            (item) =>
                item.properties.source_id === "CLASS_RECORD" &&
                item.properties.class_path === "Design",
        );
    const access = engine.storage
        .listItems("Access")
        .find(
            (item) =>
                item.properties.source_id === "SEC_EDIT" &&
                item.properties.related_id === "A73B655731924CD0B027E4F4D5FCC0A9",
        );

    if (!binding || !access) {
        throw new Error("The model must provide its class binding and World access rule.");
    }

    engine.checkpoint();
    engine.storage.putCatalogEntry({
        ...binding,
        properties: { ...binding.properties, related_id: "CLASS_OPERATIONS_MAP" },
    });
    const request = `<Item type="ClassificationRecord" action="edit" id="${original.id}"><classification>Design/Mechanical</classification></Item>`;

    expect((await engine.applyAML(request)).getErrorCode()).toBe("PermissionDenied");
    expect(engine.inspect(original).properties.state).toBe("Design draft");
    engine.storage.updateItem("Access", access.id, { can_change_access: 1 });
    const changed = await engine.applyAML(request);

    expect(changed.getProperty("state")).toBe("Operations draft");
    expect(changed.getProperty("permission_id")).toBe("SEC_READ");
    engine.reset();
    expect(engine.storage.getItem(original.type, original.id)?.properties.state).toBe(
        "Design draft",
    );
});
