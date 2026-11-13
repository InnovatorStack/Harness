import { expect, test } from "bun:test";

import { createHarness, ExecutionOutcome, seededIds } from "../src/index.js";
import { parseItems } from "../src/items/xml.js";
import {
    changedPropertiesInputSource,
    failedBaseInputSource,
    itemViewBaseInputSource,
    nestedBaseInputSource,
    queryBaseInputSource,
    queryBeforeGetSource,
    retainedBaseInputSource,
    wrappedBaseInputSource,
} from "./helpers/base-input.js";
import { generatedUpdateSources } from "./helpers/generated-updates.js";
import { referenceEvent, referenceMethod, referenceProject } from "./helpers/references.js";

test.each(["edit", "update", "version"])(
    "%s base delegation updates retained XML nodes and attributes",
    async (action) => {
        await using project = await referenceProject(
            generatedUpdateSources(true, retainedBaseInputSource),
        );
        using h = await createHarness({ cwd: project.cwd, csharp: {} });
        const parent = await h.getOne("ReferenceRecord", { name: "Parent" });

        if (action === "update") {
            await h.applyAML(`<Item type="ReferenceRecord" action="lock" id="${parent.id}" />`);
        }

        const result = await h.applyAML(
            `<Item type="ReferenceRecord" action="${action}" id="${parent.id}"><name>Saved</name></Item>`,
        );
        const audits = h.state.get("ReplacementAudit");

        expect(result.isError()).toBe(false);
        expect(audits).toHaveLength(action === "version" ? 1 : 2);

        for (const audit of audits) {
            const xml = String(audit.properties.request_xml);
            const input = parseItems(xml)[0];
            expect(input?.getID()).toBe(result.getID());
            expect(input?.getAttribute("oldId")).toBe(parent.id);
            expect(input?.getAction()).toBe("version");
            expect(xml).toContain("<!--Retained by the Method-->");
            expect(xml).toContain("<![CDATA[Saved]]>");
        }

        expect(h.state.getOne("Method", { name: "ReplaceUpdate" }).properties.method_code).toBe(
            retainedBaseInputSource,
        );
        expect(h.executions.at(-1)?.mocks).toEqual([]);
    },
    60_000,
);

test.each(["idlist", "where"])(
    "base delegation replaces a retained %s selector with the generated IDs",
    async (selector) => {
        await using project = await referenceProject(
            generatedUpdateSources(true, retainedBaseInputSource),
        );
        using h = await createHarness({ cwd: project.cwd, csharp: {} });
        const parent = await h.getOne("ReferenceRecord", { name: "Parent" });
        const child = await h.getOne("ReferenceRecord", { name: "Child" });
        const criteria =
            selector === "idlist"
                ? `idlist="${parent.id},${child.id}"`
                : `where="name = 'Parent' or name = 'Child'"`;
        const result = await h.applyAML(
            `<Item type="ReferenceRecord" action="edit" ${criteria}><name>Saved</name></Item>`,
        );
        const initial = h.state.getOne("ReplacementAudit", { phase: "initial" });
        const input = parseItems(String(initial.properties.request_xml))[0];

        expect(result.getItemCount()).toBe(2);
        expect(input?.getAttribute("idlist").split(",")).toEqual(
            result.payload.items.map((node) => node.attributes.id ?? ""),
        );
        expect(input?.getAttribute("where")).toBe("");
        expect(input?.getAttribute("oldId").split(",").sort()).toEqual(
            [parent.id, child.id].sort(),
        );
    },
    60_000,
);

test.each([
    { name: "CSharpInOut", source: nestedBaseInputSource },
    { name: "CSharp", source: itemViewBaseInputSource },
])(
    "copied relationship IDs reach retained XML and Item views through $name",
    async ({ source }) => {
        const fixtures = `ReferenceFixed: [{ source_id: { name: "Parent" }, related_id: { name: "Child" }, sort_order: 7 }],`;
        await using project = await referenceProject(
            generatedUpdateSources(true, source),
            fixtures,
        );
        using h = await createHarness({ cwd: project.cwd, csharp: {} });
        const parent = await h.getOne("ReferenceRecord", { name: "Parent" });
        const original = h.state.getOne("ReferenceFixed", { source_id: parent.id });
        const result =
            await h.applyAML(`<Item type="ReferenceRecord" action="edit" id="${parent.id}"><name>Saved</name>
        <Relationships><Item type="ReferenceFixed" action="edit" id="${original.id}"><sort_order>20</sort_order></Item></Relationships></Item>`);

        expect(result.isError()).toBe(false);
        expect(
            h.state.getOne("ReferenceFixed", { source_id: result.getID() }).properties.sort_order,
        ).toBe(20);
        expect(h.state.getOne("ReferenceFixed", { id: original.id }).properties.sort_order).toBe(7);
        expect(h.executions.at(-1)?.mocks).toEqual([]);
    },
    60_000,
);

test("ordinary Item helpers and wrapped documents observe base changes through their existing views", async () => {
    await using project = await referenceProject(
        generatedUpdateSources(true, wrappedBaseInputSource),
    );
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const parent = await h.getOne("ReferenceRecord", { name: "Parent" });
    const saved = await h.update(parent, { name: "Saved" });

    expect(saved.id).not.toBe(parent.id);
    expect(saved.properties).toMatchObject({ name: "Saved", generation: 2, config_id: parent.id });
    expect(h.executions.at(-1)?.mocks).toEqual([]);
}, 60_000);

test.each(["Saved", "", null])(
    "real version hooks change, insert and remove properties while retained XML views stay live: %j",
    async (name) => {
        const schema = `<Item type="ItemType" action="edit" id="REF_RECORD"><Relationships>
        <Item type="Property" action="add"><name>count</name><data_type>integer</data_type>
            <default_value>0</default_value></Item></Relationships></Item>`;
        const hook =
            referenceMethod(
                "ChangeVersionInput",
                'this.setProperty("name", "Hook value"); this.removeProperty("count"); return this;',
            ) + referenceEvent("REF_RECORD", "onBeforeVersion", "ChangeVersionInput");
        await using project = await referenceProject(
            schema + generatedUpdateSources(true, changedPropertiesInputSource) + hook,
        );
        using h = await createHarness({ cwd: project.cwd, csharp: {} });
        const parent = await h.getOne("ReferenceRecord", { name: "Parent" });
        const saved = await h.update(parent, { name, count: 6 });

        expect(saved.properties).toMatchObject({ name: "Hook value", generation: 2, count: 0 });
        expect(h.state.getOne("ReferenceRecord", { id: parent.id }).properties.name).toBe("Parent");
        expect(h.executions.at(-1)?.mocks).toEqual([]);
    },
    60_000,
);

test("base failure returns the mutated input before the real Method examines its native fault", async () => {
    const rejection =
        referenceMethod(
            "RejectBeforeVersion",
            'return this.getInnovator().newError("Reject native version");',
        ) + referenceEvent("REF_RECORD", "onBeforeVersion", "RejectBeforeVersion");
    await using project = await referenceProject(
        generatedUpdateSources(true, failedBaseInputSource) + rejection,
    );
    using h = await createHarness({
        cwd: project.cwd,
        csharp: {},
    });
    const parent = await h.getOne("ReferenceRecord", { name: "Parent" });
    const before = h.state.get("ReferenceRecord");
    await expect(
        h.applyAML(
            `<Item type="ReferenceRecord" action="edit" id="${parent.id}"><name>Rejected</name></Item>`,
        ),
    ).rejects.toThrow("Verified live version input after failed base");

    expect(h.state.get("ReferenceRecord")).toEqual(before);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
}, 60_000);

test("live base input and controlled IDs reset independently in separate worlds", async () => {
    await using project = await referenceProject(
        generatedUpdateSources(true, retainedBaseInputSource),
    );
    const options = { cwd: project.cwd, csharp: {}, ids: seededIds("base-input-reset") };
    using h = await createHarness(options);
    using other = await createHarness(options);
    const parent = await h.getOne("ReferenceRecord", { name: "Parent" });
    const original = h.state.get("ReferenceRecord");
    const result = await h.update(parent, { name: "Saved" });
    h.reset();
    expect(h.state.get("ReferenceRecord")).toEqual(original);
    expect(h.state.get("ReplacementAudit")).toEqual([]);
    expect(h.executions).toEqual([]);
    const repeated = await h.update(await h.getOne("ReferenceRecord", { name: "Parent" }), {
        name: "Saved",
    });

    expect(repeated.id).toBe(result.id);
    expect(other.state.get("ReferenceRecord")).toEqual(original);
    expect(other.state.get("ReplacementAudit")).toEqual([]);
}, 60_000);

test("unchanged large request values are not duplicated into synchronization messages", async () => {
    const schema = `<Item type="ItemType" action="edit" id="REF_RECORD"><Relationships>
        <Item type="Property" action="add"><name>large_text</name><data_type>text</data_type></Item>
    </Relationships></Item>`;
    const source =
        referenceMethod(
            "DelegateLargeInput",
            "// MethodTemplateName = CSharpInOut;\neventData.BaseUpdateItem(outDom);",
        ) + referenceEvent("REF_RECORD", "onUpdate", "DelegateLargeInput");
    await using project = await referenceProject(schema + source);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const parent = await h.getOne("ReferenceRecord", { name: "Parent" });
    const text = "x".repeat(3 * 1024 * 1024);
    const saved = await h.update(parent, { name: "Saved", large_text: text });

    expect(saved.properties.large_text).toBe(text);
    expect(saved.properties.generation).toBe(2);
    expect(h.state.getOne("ReferenceRecord", { id: saved.id }).properties.large_text).toBe(text);
}, 60_000);

test("a caught synchronization failure cannot commit base writes or leak its input into another world", async () => {
    const source = `// MethodTemplateName = CSharpInOut;
        var input = inDom.DocumentElement ?? throw new Exception("Missing request");
        bool initial = !input.HasAttribute("oldId");
        if (initial) { AppDomain.CurrentDomain.SetData("retained-base-input", input); }
        try { eventData.BaseUpdateItem(outDom); }
        catch (Exception) { outDom.LoadXml("<Result>Caught synchronization failure</Result>"); }
        finally { if (initial) { AppDomain.CurrentDomain.SetData("retained-base-input", null); } }`;
    const hook =
        referenceMethod(
            "ChangeRetainedInput",
            `
        var input = AppDomain.CurrentDomain.GetData("retained-base-input") as System.Xml.XmlElement;
        var name = input?.SelectSingleNode("name");
        if (name != null) { input.RemoveChild(name); }
        this.setProperty("name", "Changed");
        return this;`,
        ) + referenceEvent("REF_RECORD", "onBeforeVersion", "ChangeRetainedInput");
    await using project = await referenceProject(generatedUpdateSources(true, source) + hook);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    using other = await createHarness({ cwd: project.cwd, csharp: {} });
    const parent = await h.getOne("ReferenceRecord", { name: "Parent" });
    const before = h.state.get("ReferenceRecord");

    await expect(h.update(parent, { name: "Rejected" })).rejects.toThrow(
        "input request changed during its base call",
    );
    expect(h.state.get("ReferenceRecord")).toEqual(before);
    expect(other.state.get("ReferenceRecord")).toEqual(before);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
}, 60_000);

test("Get base changes preserve implicit query groups and expanded Item-property views", async () => {
    const source =
        referenceMethod("DelegateQueryInput", queryBaseInputSource) +
        referenceEvent("REF_RECORD", "onGet", "DelegateQueryInput") +
        referenceMethod("ChangeQueryInput", queryBeforeGetSource) +
        referenceEvent("REF_RECORD", "onBeforeGet", "ChangeQueryInput");
    await using project = await referenceProject(source);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const before = h.state.get("ReferenceRecord");
    const result = await h.applyAML(`<Item type="ReferenceRecord" action="get">
        <name condition="ne">Other parent</name><name condition="ne">Missing</name>
        <fixed_ref><Item type="ReferenceRecord" action="get"><name>Other parent</name></Item></fixed_ref>
    </Item>`);

    expect(result.getErrorCode()).toBe("0");
    expect(h.state.get("ReferenceRecord")).toEqual(before);
    expect(h.executions.at(-1)?.mocks).toEqual([]);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.Committed);
}, 60_000);
