import { expect, test } from "bun:test";

import { createHarness, ExecutionOutcome, seededIds } from "../src/index.js";
import { referenceEvent, referenceMethod, referenceProject } from "./helpers/references.js";

const inspectId = `
string id = this.getID();
if (!System.Text.RegularExpressions.Regex.IsMatch(id, "^[A-F0-9]{32}$"))
{
    throw new Exception("onBeforeAdd did not receive an allocated ID");
}
this.setProperty("name", id);
return this;`;

test.each([
    { name: "missing", attribute: "" },
    { name: "empty", attribute: ' id=""' },
])(
    "raw Add with a $name ID allocates it before the original before-hook",
    async ({ attribute }) => {
        const methods =
            referenceMethod("InspectAddId", inspectId) +
            referenceEvent("REF_HOLDER", "onBeforeAdd", "InspectAddId");
        await using project = await referenceProject(methods);
        using h = await createHarness({ cwd: project.cwd, csharp: {} });
        const result = await h.applyAML(
            `<Item type="ReferenceHolder" action="add"${attribute}><name>Requested</name></Item>`,
        );

        expect(result.isError()).toBe(false);
        expect(result.getProperty("name")).toBe(result.getID());
        expect(h.state.getOne("ReferenceHolder", { id: result.getID() }).properties.name).toBe(
            result.getID(),
        );
        expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.Committed);
    },
    60_000,
);

test.each([
    { type: "ReferenceHolder", typeId: "REF_HOLDER" },
    { type: "ReferenceRecord", typeId: "REF_RECORD" },
])(
    "TypeScript Add allocates $type before onBeforeAdd",
    async ({ type, typeId }) => {
        const methods =
            referenceMethod("InspectAddId", inspectId) +
            referenceEvent(typeId, "onBeforeAdd", "InspectAddId");
        await using project = await referenceProject(methods);
        using h = await createHarness({ cwd: project.cwd, csharp: {} });
        const result = await h.add(type, { name: "Requested" });

        expect(result.properties.name).toBe(result.id);
        expect(result.properties.config_id).toBe(result.id);
        expect(h.state.getOne(type, { id: result.id }).properties.name).toBe(result.id);
    },
    60_000,
);

test("parent allocation precedes nested hook calls and embedded property additions", async () => {
    const source = `${inspectId.replace("return this;", "")}
var child = this.getInnovator().applyAML(
    "<Item type='ReferenceRecord' action='add'><name>From before hook</name></Item>");
if (child.isError()) { return child; }
return this;`;
    const methods =
        referenceMethod("AddDuringBeforeAdd", source) +
        referenceEvent("REF_HOLDER", "onBeforeAdd", "AddDuringBeforeAdd");
    await using project = await referenceProject(methods);
    const options = { cwd: project.cwd, csharp: {}, ids: seededIds("add-order") };
    using baseline = await createHarness(options);
    const expected: string[] = [];

    for (let index = 0; index < 3; index += 1) {
        const saved = await baseline.applyAML(
            '<Item type="ReferenceHolder" action="add" serverEvents="0" />',
        );
        expected.push(saved.getID());
    }

    using h = await createHarness(options);
    const result = await h.applyAML(`<Item type="ReferenceHolder" action="add">
        <note><Item type="ReferenceNote" action="add"><name>Embedded note</name></Item></note>
    </Item>`);
    const child = h.state.getOne("ReferenceRecord", { name: "From before hook" });
    const note = h.state.getOne("ReferenceNote", { name: "Embedded note" });

    expect([result.getID(), child.id, note.id]).toEqual(expected);
    expect(result.getProperty("name")).toBe(result.getID());
    expect(h.state.getOne("ReferenceHolder", { id: result.getID() }).properties.note).toBe(note.id);
}, 60_000);

test.each(["CSharp", "CSharpInOut"])(
    "%s BaseAdd receives its generated input ID only after delegation",
    async (template) => {
        const body = `
var input = inDom.DocumentElement;
if (input.HasAttribute("id") && input.GetAttribute("id") != "")
{
    throw new Exception("onAdd allocated an ID before the default action");
}
eventData.BaseAddItem(outDom);
var saved = outDom.SelectSingleNode("//Result/Item") as System.Xml.XmlElement;
if (saved == null || input.GetAttribute("id") != saved.GetAttribute("id"))
{
    throw new Exception("BaseAdd did not synchronize its allocated input ID");
}`;
        const source =
            template === "CSharpInOut"
                ? `// MethodTemplateName = CSharpInOut;\n${body}`
                : `var inDom = this.dom;
var outDom = new System.Xml.XmlDocument();
${body}
var result = this.newItem();
result.loadAML(outDom.OuterXml);
return result;`;
        const methods =
            referenceMethod("InspectBaseAddId", source) +
            referenceEvent("REF_HOLDER", "onAdd", "InspectBaseAddId") +
            referenceMethod("InspectAddId", inspectId) +
            referenceEvent("REF_HOLDER", "onBeforeAdd", "InspectAddId");
        await using project = await referenceProject(methods);
        using h = await createHarness({ cwd: project.cwd, csharp: {} });
        const result = await h.add("ReferenceHolder", { name: "Requested" });

        expect(result.properties.name).toBe(result.id);
        expect(h.state.get("ReferenceHolder")).toHaveLength(1);
    },
    60_000,
);

test("a replacement that skips BaseAdd does not consume a default Add ID", async () => {
    const methods =
        referenceMethod("SkipAdd", 'return this.getInnovator().newResult("Skipped");') +
        referenceEvent("REF_HOLDER", "onAdd", "SkipAdd");
    await using project = await referenceProject(methods);
    const options = { cwd: project.cwd, csharp: {}, ids: seededIds("replacement-add") };
    using h = await createHarness(options);
    using baseline = await createHarness(options);
    const result = await h.applyAML('<Item type="ReferenceHolder" action="add" />');
    const next = await h.add("ReferenceRecord", { name: "Next" });
    const expected = await baseline.add("ReferenceRecord", { name: "Expected" });

    expect(result.getResult()).toBe("Skipped");
    expect(h.state.get("ReferenceHolder")).toEqual([]);
    expect(next.id).toBe(expected.id);
}, 60_000);

test("an explicit Add ID is retained without advancing the controlled sequence", async () => {
    const methods =
        referenceMethod("InspectAddId", inspectId) +
        referenceEvent("REF_HOLDER", "onBeforeAdd", "InspectAddId");
    await using project = await referenceProject(methods);
    const options = { cwd: project.cwd, csharp: {}, ids: seededIds("explicit-add") };
    using h = await createHarness(options);
    using baseline = await createHarness(options);
    const explicitId = "E1000000000000000000000000000001";
    const explicit = await h.applyAML(
        `<Item type="ReferenceHolder" action="add" id="${explicitId}" />`,
    );
    const next = await h.add("ReferenceHolder", { name: "Next" });
    const expected = await baseline.add("ReferenceHolder", { name: "Expected" });

    expect(explicit.getID()).toBe(explicitId);
    expect(explicit.getProperty("name")).toBe(explicitId);
    expect(next.id).toBe(expected.id);
}, 60_000);

test("SDK preallocation and default Add share the same ID without allocating twice", async () => {
    const source = `
var item = this.newItem("ReferenceHolder", "add");
string id = item.getID();
var saved = item.apply();
if (saved.isError()) { return saved; }
if (saved.getID() != id) { throw new Exception("Add replaced the SDK allocation"); }
return this.getInnovator().newResult(id + "," + this.getInnovator().getNewID());`;
    const methods =
        referenceMethod("SdkAdd", source) +
        referenceMethod("InspectAddId", inspectId) +
        referenceEvent("REF_HOLDER", "onBeforeAdd", "InspectAddId");
    await using project = await referenceProject(methods);
    const options = { cwd: project.cwd, csharp: {}, ids: seededIds("sdk-add") };
    using baseline = await createHarness(options);
    const first = await baseline.add("ReferenceHolder", { name: "First" });
    const second = await baseline.add("ReferenceHolder", { name: "Second" });
    using h = await createHarness(options);
    const result = await h.callMethod("SdkAdd");

    expect(result.getResult()).toBe(`${first.id},${second.id}`);
    expect(h.state.getOne("ReferenceHolder", { id: first.id }).properties.name).toBe(first.id);
}, 60_000);

test("rejected before-hooks roll back nested writes while ID reset stays world-local", async () => {
    const source = `
string id = this.getID();
var nested = this.getInnovator().applyAML(
    "<Item type='ReferenceRecord' action='add'><name>Must roll back</name></Item>");
if (nested.isError()) { return nested; }
throw new Exception("Rejected add " + id);`;
    const methods =
        referenceMethod("RejectAdd", source) +
        referenceEvent("REF_HOLDER", "onBeforeAdd", "RejectAdd");
    await using project = await referenceProject(methods);
    const options = { cwd: project.cwd, csharp: {}, ids: seededIds("rejected-add") };
    using baseline = await createHarness(options);
    const initial = await baseline.add("ReferenceRecord", { name: "First" });
    const nested = await baseline.add("ReferenceRecord", { name: "Second" });
    const following = await baseline.add("ReferenceRecord", { name: "Third" });
    using first = await createHarness(options);
    using second = await createHarness(options);
    const original = first.state.get("ReferenceRecord");

    await expect(first.add("ReferenceHolder", { name: "Rejected" })).rejects.toThrow(
        `Rejected add ${initial.id}`,
    );
    expect(first.state.get("ReferenceHolder")).toEqual([]);
    expect(first.state.get("ReferenceRecord")).toEqual(original);
    expect(first.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
    expect(first.executions.at(-1)?.changes).toHaveLength(1);
    expect((await first.add("ReferenceRecord", { name: "After rejection" })).id).toBe(following.id);
    expect((await second.add("ReferenceRecord", { name: "Other world" })).id).toBe(initial.id);
    first.reset();

    expect((await first.add("ReferenceRecord", { name: "After reset" })).id).toBe(initial.id);
    expect((await second.add("ReferenceRecord", { name: "Still independent" })).id).toBe(nested.id);
}, 60_000);

test.each(["", "E2000000000000000000000000000001"])(
    "a before-hook cannot silently replace its captured Add ID with '%s'",
    async (id) => {
        const source = `
var nested = this.getInnovator().applyAML(
    "<Item type='ReferenceRecord' action='add'><name>Must roll back</name></Item>");
if (nested.isError()) { return nested; }
this.setID("${id}");
return this;`;
        const methods =
            referenceMethod("ChangeAddId", source) +
            referenceEvent("REF_HOLDER", "onBeforeAdd", "ChangeAddId");
        await using project = await referenceProject(methods);
        using h = await createHarness({ cwd: project.cwd, csharp: {} });
        const original = h.state.get("ReferenceRecord");

        await expect(h.add("ReferenceHolder", { name: "Requested" })).rejects.toMatchObject({
            code: "UnsupportedContextChange",
        });
        expect(h.state.get("ReferenceHolder")).toEqual([]);
        expect(h.state.get("ReferenceRecord")).toEqual(original);
        expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
    },
    60_000,
);

test("abandoned Add work cannot consume IDs after rollback and reset", async () => {
    await using project = await referenceProject(referenceMethod("AbandonAdd", "return this;"));
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<unknown>();
    void pending.promise.catch(() => {
        // Invalidating the parent can reject its child before the test resumes.
    });
    const options = { cwd: project.cwd, ids: seededIds("abandoned-add") };
    using baseline = await createHarness(options);
    const expected = await baseline.add("ReferenceRecord", { name: "Expected" });
    using h = await createHarness({
        ...options,

        async authorization(request) {
            if (request.name === "ReferenceHolder.add") {
                entered.resolve();
                await resume.promise;
            }
        },

        executors: [
            () => ({
                language: "C#",

                async execute(_method, context, ports) {
                    const abandoned = ports.applyAML(
                        '<Item type="ReferenceHolder" action="add"><name>Abandoned</name></Item>',
                    );
                    void abandoned.catch(() => {
                        // The test inspects this failure after releasing authorization.
                    });
                    pending.resolve(abandoned);
                    await entered.promise;

                    return context;
                },
            }),
        ],
    });

    await expect(h.callMethod("AbandonAdd")).rejects.toMatchObject({
        code: "UnfinishedExecution",
    });
    h.reset();
    resume.resolve();

    await expect(pending.promise).rejects.toMatchObject({ code: "UnfinishedExecution" });
    expect(h.state.get("ReferenceHolder")).toEqual([]);
    expect((await h.add("ReferenceRecord", { name: "After abandonment" })).id).toBe(expected.id);
});
