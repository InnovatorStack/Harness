import { expect, test } from "bun:test";
import { realpath } from "node:fs/promises";
import { join } from "node:path";

import { dataDepthMax } from "../src/core/limits.js";
import { createEngine } from "../src/engine.js";
import { AuthorizationMode, CapabilityId, createHarness, ExecutionOutcome } from "../src/index.js";
import { referenceEvent, referenceMethod } from "./helpers/references.js";
import { securityProject } from "./helpers/security.js";

const structure = `<class name="Display label">
    <class name="Technical">
        <class name="Purchased" />
        <class name="Manufactured" />
    </class>
    <class name="TechnicalExtra" />
    <class name="Commercial" />
</class>`;

function model(grants = "", xml = structure, defaultClass = ""): string {
    return `<Item type="ItemType" action="add" id="SEC_CLASSIFIED">
        <name>ClassifiedDocument</name>
        <class_structure><![CDATA[${xml}]]></class_structure>
        <Relationships>
            <Item type="Property" action="add">
                <name>name</name><data_type>string</data_type>
            </Item>
            <Item type="Property" action="add">
                <name>classification</name><data_type>string</data_type>${defaultClass}
            </Item>
            <Item type="Allowed Permission" action="add">
                <related_id>SEC_EDIT</related_id><is_default>1</is_default>
            </Item>
            ${grants}
        </Relationships>
    </Item>`;
}

function grant(path: string, identity = "SEC_EDITORS", enabled = 1): string {
    return `<Item type="Can Add" action="add">
        <related_id>${identity}</related_id><can_add>${enabled}</can_add>
        <class_path>${path}</class_path>
    </Item>`;
}

test.each([
    { classification: "Technical", code: "InvalidClassification" },
    { classification: "Technical/Purchased", code: "" },
    { classification: "Technical/Manufactured", code: "" },
    { classification: "TechnicalExtra", code: "PermissionDenied" },
    { classification: "Commercial", code: "PermissionDenied" },
    { classification: "technical/Purchased", code: "InvalidClassification" },
    { classification: "Technical/Unknown", code: "InvalidClassification" },
    { classification: "Technical/", code: "InvalidClassification" },
    { classification: "", code: "PermissionDenied" },
])("class-specific creation checks the exported tree: %s", async (scenario) => {
    const source = model(
        grant("Technical") +
            grant("Technical/Purchased", "SEC_EDITORS", 0) +
            grant("Commercial", "SEC_PUBLISHERS"),
    );
    await using project = await securityProject(source);
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });
    const result = await h.applyAML(`<Item type="ClassifiedDocument" action="add">
        <name>Classified</name><classification>${scenario.classification}</classification>
    </Item>`);

    expect(result.getErrorCode()).toBe(scenario.code);
    expect(h.state.get("ClassifiedDocument")).toHaveLength(scenario.code === "" ? 1 : 0);

    if (scenario.code === "") {
        expect(h.state.getOne("ClassifiedDocument", {}).properties.classification).toBe(
            scenario.classification,
        );
    } else {
        expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
    }
});

test("root grants cover declared classes and the root without authorizing invented paths", async () => {
    await using project = await securityProject(model(grant("")));
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });

    for (const classification of [undefined, null, "", "Commercial", "Technical/Purchased"]) {
        const values = classification === undefined ? {} : { classification };
        const record = await h.add("ClassifiedDocument", { name: "Permitted", ...values });

        expect(record.properties.classification ?? null).toBe(classification ?? null);
    }

    await expect(
        h.add("ClassifiedDocument", { name: "Unknown", classification: "Not declared" }),
    ).rejects.toThrow("Invalid classification");
    expect(h.state.get("ClassifiedDocument")).toHaveLength(5);
});

test.each(["/", "*", "Technical/*", "Missing"])(
    "a Can Add path '%s' does not become a wildcard or a new class",
    async (path) => {
        await using project = await securityProject(model(grant(path)));
        using h = await createHarness({
            cwd: project.cwd,
            authorization: AuthorizationMode.Native,
        });

        await expect(
            h.add("ClassifiedDocument", { classification: "Technical/Purchased" }),
        ).rejects.toThrow("Cannot add");
        await expect(h.add("ClassifiedDocument", {})).rejects.toThrow("Cannot add");
        expect(h.state.get("ClassifiedDocument")).toEqual([]);
    },
);

test("an ItemType without a class tree only has its unclassified root", async () => {
    await using project = await securityProject(model(grant(""), ""));
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });
    const record = await h.add("ClassifiedDocument", { name: "Root" });

    expect(record.properties.name).toBe("Root");
    await expect(
        h.add("ClassifiedDocument", { classification: "Technical/Purchased" }),
    ).rejects.toThrow("Invalid classification");
    expect(h.state.get("ClassifiedDocument")).toHaveLength(1);
});

test("the declared classification default participates in creation authorization", async () => {
    const source = model(
        grant("Technical"),
        structure,
        "<default_value>Commercial</default_value>",
    );
    await using project = await securityProject(source);
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });
    await expect(h.add("ClassifiedDocument", {})).rejects.toThrow("Cannot add");
    const permitted = await h.add("ClassifiedDocument", {
        classification: "Technical/Purchased",
    });

    expect(permitted.properties.classification).toBe("Technical/Purchased");
    expect(h.state.get("ClassifiedDocument")).toHaveLength(1);
});

test("classification defaults select the same class for permission and lifecycle initialization", async () => {
    const schema = model(
        grant("Technical"),
        structure,
        "<default_value>Technical/Purchased</default_value>",
    );
    const source = `${schema}<Item type="Life Cycle Map" action="add" id="SEC_CLASS_CYCLE">
            <name>Classified lifecycle</name><start_state>SEC_CLASS_START</start_state>
            <Relationships><Item type="Life Cycle State" action="add" id="SEC_CLASS_START">
                <name>Purchased draft</name>
            </Item></Relationships>
        </Item>
        <Item type="ItemType Life Cycle" action="add">
            <source_id>SEC_CLASSIFIED</source_id><related_id>SEC_CLASS_CYCLE</related_id>
            <class_path>Technical</class_path>
        </Item>`;
    await using project = await securityProject(source);
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });
    const record = await h.add("ClassifiedDocument", { name: "Default class" });

    expect(record.properties).toMatchObject({
        classification: "Technical/Purchased",
        current_state: "SEC_CLASS_START",
        state: "Purchased draft",
    });
    expect(h.state.getOne("ClassifiedDocument", { id: record.id }).properties).toMatchObject({
        classification: "Technical/Purchased",
        state: "Purchased draft",
    });
    await expect(h.add("ClassifiedDocument", { classification: null })).rejects.toThrow(
        "Cannot add",
    );
});

test.each([
    "<class>",
    "<other />",
    '<class><class name="Technical" /><class name="Technical" /></class>',
    "<class><class /></class>",
    '<class><class name="Technical/Purchased" /></class>',
    "<class>Unexpected text</class>",
    '<class><other name="Technical" /></class>',
    '<!DOCTYPE class [<!ENTITY extra "Technical">]><class />',
])("invalid class metadata fails with source diagnostics before creation: %s", async (xml) => {
    await using project = await securityProject(model(grant(""), xml));
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });
    const file = await realpath(join(project.cwd, ".harness/packages/source.xml"));
    await expect(h.add("ClassifiedDocument", {})).rejects.toMatchObject({
        code: "InvalidClassStructure",
        capability: CapabilityId.NativePermissions,
        source: { file },
    });

    expect(h.state.get("ClassifiedDocument")).toEqual([]);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
});

test("class metadata parsing is bounded before native creation", async () => {
    const nested = '<class name="Nested">'.repeat(dataDepthMax + 1);
    const xml = `${nested}${"</class>".repeat(dataDepthMax + 1)}`;
    await using project = await securityProject(model(grant(""), xml));
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });
    await expect(h.add("ClassifiedDocument", {})).rejects.toMatchObject({
        code: "InvalidClassStructure",
    });

    expect(h.state.get("ClassifiedDocument")).toEqual([]);
});

test("expanded class paths have a total text budget independent of XML depth", async () => {
    const opening = `<class name="${"x".repeat(5000)}">`;
    const xml = `${opening.repeat(100)}${"</class>".repeat(100)}`;
    await using project = await securityProject(model(grant(""), xml));
    using h = await createHarness({ cwd: project.cwd, authorization: AuthorizationMode.Native });
    await expect(h.add("ClassifiedDocument", {})).rejects.toMatchObject({
        code: "InvalidClassStructure",
        message:
            "Invalid class_structure for 'ClassifiedDocument': Class paths exceed the text limit.",
    });

    expect(h.state.get("ClassifiedDocument")).toEqual([]);
});

test("cached class paths follow metadata replacement and world reset", async () => {
    await using project = await securityProject(
        model(grant("", "A73B655731924CD0B027E4F4D5FCC0A9")),
    );
    let actor = "";
    using engine = createEngine({
        authorization: AuthorizationMode.Native,

        userId: () => actor,
    });
    const user = engine.storage
        .listItems("User")
        .find((record) => record.properties.login_name === "admin");

    if (!user) {
        throw new Error("The baseline must provide its administrator User.");
    }

    actor = user.id;
    await engine.loadPackages([join(project.cwd, ".harness/packages/source.xml")]);
    const metadata = engine.storage.getCatalogEntry("ItemType", "SEC_CLASSIFIED");

    if (!metadata) {
        throw new Error("The imported class tree must retain its ItemType metadata.");
    }

    const request = `<Item type="ClassifiedDocument" action="add" doGetItem="0">
        <classification>Technical/Purchased</classification>
    </Item>`;
    engine.checkpoint();
    expect((await engine.applyAML(request)).isError()).toBe(false);
    const replacement = {
        ...metadata,
        properties: {
            ...metadata.properties,
            class_structure: '<class><class name="Other" /></class>',
        },
    };
    engine.storage.putCatalogEntry(replacement);

    expect((await engine.applyAML(request)).getErrorCode()).toBe("InvalidClassification");
    engine.storage.putCatalogEntry(metadata);
    expect((await engine.applyAML(request)).isError()).toBe(false);
    engine.storage.putCatalogEntry(replacement);
    expect((await engine.applyAML(request)).getErrorCode()).toBe("InvalidClassification");
    engine.reset();
    expect(engine.storage.listItems("ClassifiedDocument")).toEqual([]);
    expect((await engine.applyAML(request)).isError()).toBe(false);
});

test("C# grants permit only their declared class and expire after the Method returns", async () => {
    const code = `
var identity = Aras.Server.Security.Identity.GetByName("Test publishers");
using (CCO.Permissions.GrantIdentity(identity))
{
    var item = this.newItem("ClassifiedDocument", "add");
    item.setProperty("name", "Granted creation");
    item.setProperty("classification", this.getProperty("classification"));
    return item.apply();
}`;
    const source =
        model(grant("Technical") + grant("Commercial", "SEC_PUBLISHERS")) +
        referenceMethod("CreateClassified", code);
    await using project = await securityProject(source);
    using h = await createHarness({
        cwd: project.cwd,
        authorization: AuthorizationMode.Native,
        csharp: {},
    });
    const accepted = await h.callMethod("CreateClassified", { classification: "Commercial" });
    const denied = await h.callMethod("CreateClassified", { classification: "TechnicalExtra" });

    expect(accepted.isError()).toBe(false);
    expect(denied.getErrorCode()).toBe("PermissionDenied");
    expect(h.state.getOne("ClassifiedDocument", {}).properties.classification).toBe("Commercial");
    await expect(h.add("ClassifiedDocument", { classification: "Commercial" })).rejects.toThrow(
        "Cannot add",
    );
    h.reset();
    expect(h.state.get("ClassifiedDocument")).toEqual([]);
    await expect(h.add("ClassifiedDocument", { classification: "Commercial" })).rejects.toThrow(
        "Cannot add",
    );
}, 60_000);

test("an onBeforeAdd classification change is authorized and rolls back earlier batch writes", async () => {
    const source =
        model(grant("Technical")) +
        referenceMethod(
            "ReclassifyBeforeAdd",
            'this.setProperty("classification", "Commercial"); return this;',
        ) +
        referenceEvent("SEC_CLASSIFIED", "onBeforeAdd", "ReclassifyBeforeAdd");
    await using project = await securityProject(source);
    using h = await createHarness({
        cwd: project.cwd,
        authorization: AuthorizationMode.Native,
        csharp: {},
    });
    const before = h.state.get("SecurityDocument");
    const result = await h.applyAML(`<AML>
        <Item type="SecurityDocument" action="add"><name>Must roll back</name></Item>
        <Item type="ClassifiedDocument" action="add">
            <classification>Technical/Purchased</classification>
        </Item>
    </AML>`);

    expect(result.getErrorCode()).toBe("PermissionDenied");
    expect(h.state.get("SecurityDocument")).toEqual(before);
    expect(h.state.get("ClassifiedDocument")).toEqual([]);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
    expect(
        h.trace.some((event) => event.kind === "method" && event.name === "ReclassifyBeforeAdd"),
    ).toBe(true);
}, 60_000);
