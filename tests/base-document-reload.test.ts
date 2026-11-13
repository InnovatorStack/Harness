import { expect, test } from "bun:test";

import { createHarness, ExecutionOutcome, seededIds } from "../src/index.js";
import { baseDocumentMethods } from "./helpers/base-documents.js";
import { referenceEvent, referenceMethod, referenceProject } from "./helpers/references.js";

const profiles = ["CSharp", "CSharpInOut"].flatMap((template) => [
    { template, verb: "Get" as const },
    { template, verb: "Add" as const },
]);

test.each(profiles)(
    "$template Base$verb retains its captured request and receives the actual reloaded document",
    async ({ template, verb }) => {
        await using project = await referenceProject(baseDocumentMethods(verb, template));
        using h = await createHarness({ cwd: project.cwd, csharp: {} });
        const before = h.state.get("ReferenceRecord");
        const type = verb === "Get" ? "ReferenceRecord" : "ReferenceHolder";
        const result = await h.applyAML(
            `<Item type="${type}" action="${verb.toLowerCase()}"><name>Requested</name></Item>`,
        );

        expect(result.isError()).toBe(false);
        expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.Committed);
        expect(h.executions.at(-1)?.mocks).toEqual([]);
        expect(h.state.get("ReferenceRecord")).toEqual(before);

        if (verb === "Get") {
            expect(result.getProperty("name")).toBe("Parent");
        } else {
            expect(h.state.getOne(type, { id: result.getID() }).properties.name).toBe(
                "Saved captured value",
            );
            expect(h.state.get(type)).toHaveLength(1);
        }
    },
    60_000,
);

test.each(["CSharp", "CSharpInOut"])(
    "%s returns the reloaded input on a base fault while nested writes roll back",
    async (template) => {
        const reject = `
var saved = this.getInnovator().applyAML(
    "<Item type='ReferenceRecord' action='add'><name>Must roll back</name></Item>");
if (saved.isError()) { return saved; }
return this.getInnovator().newError("Rejected reloaded Add");`;
        const methods =
            baseDocumentMethods("Add", template) +
            referenceMethod("RejectBaseDocument", reject) +
            referenceEvent("REF_HOLDER", "onBeforeAdd", "RejectBaseDocument", { order: 30 });
        await using project = await referenceProject(methods);
        using h = await createHarness({ cwd: project.cwd, csharp: {} });
        const original = h.state.get("ReferenceRecord");

        await expect(h.add("ReferenceHolder", { name: "Requested" })).rejects.toThrow(
            "Rejected reloaded Add",
        );
        expect(h.state.get("ReferenceHolder")).toEqual([]);
        expect(h.state.get("ReferenceRecord")).toEqual(original);
        expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
        expect(h.executions.at(-1)?.changes).toHaveLength(1);
    },
    60_000,
);

test("reloaded base documents remain independent across worlds and controlled reset", async () => {
    await using project = await referenceProject(baseDocumentMethods("Add", "CSharp"));
    const options = { cwd: project.cwd, csharp: {}, ids: seededIds("base-documents") };
    using first = await createHarness(options);
    using second = await createHarness(options);
    const left = await first.add("ReferenceHolder", { name: "First" });
    const right = await second.add("ReferenceHolder", { name: "Second" });
    const originalRight = second.state.getOne("ReferenceHolder", { id: right.id });

    expect(left.id).toBe(right.id);
    first.reset();
    expect(first.state.get("ReferenceHolder")).toEqual([]);
    expect(second.state.getOne("ReferenceHolder", { id: right.id })).toEqual(originalRight);
    const repeated = await first.add("ReferenceHolder", { name: "Repeated" });

    expect(repeated.id).toBe(left.id);
    expect(repeated.properties.name).toBe("Saved captured value");
    expect(second.state.get("ReferenceHolder")).toHaveLength(1);
}, 60_000);

test("moving a retained base request into a new container cannot silently pass", async () => {
    const delegate = `
try { eventData.BaseGetItem(new System.Xml.XmlDocument()); }
catch (Exception) { }
return this.getInnovator().newResult("Caught unsupported layout");`;
    const move = `
var saved = this.getInnovator().applyAML(
    "<Item type='ReferenceHolder' action='add'><name>Must roll back</name></Item>");
if (saved.isError()) { return saved; }
var root = this.dom.DocumentElement;
this.dom.RemoveChild(root);
var wrapper = this.dom.CreateElement("AML");
this.dom.AppendChild(wrapper);
wrapper.AppendChild(root);
return this;`;
    const methods =
        referenceMethod("CatchMovedDocument", delegate) +
        referenceEvent("REF_RECORD", "onGet", "CatchMovedDocument") +
        referenceMethod("MoveBaseDocument", move) +
        referenceEvent("REF_RECORD", "onBeforeGet", "MoveBaseDocument");
    await using project = await referenceProject(methods);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const original = h.state.get("ReferenceRecord");

    await expect(
        h.applyAML('<Item type="ReferenceRecord" action="get"><name>Parent</name></Item>'),
    ).rejects.toMatchObject({ code: "UnsupportedRequestIdentity" });
    expect(h.state.get("ReferenceHolder")).toEqual([]);
    expect(h.state.get("ReferenceRecord")).toEqual(original);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
}, 60_000);
