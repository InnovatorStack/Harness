import { expect, test } from "bun:test";

import { createHarness, ExecutionOutcome } from "../src/index.js";
import { Item } from "../src/items/item.js";
import { csharp } from "../src/methods/csharp/index.js";
import type { MethodExecutor } from "../src/methods/types.js";
import { referenceEvent, referenceMethod, referenceProject } from "./helpers/references.js";

interface RetainedInput {
    readonly selected: Item;
    readonly document: Item;
}

function retainingExecutor(observed: RetainedInput[]): () => MethodExecutor {
    return () => {
        const executor = csharp();

        return {
            language: executor.language,

            async execute(method, context, ports) {
                const selected = new Item({ items: [context.node] });

                try {
                    return await executor.execute(method, context, ports);
                } finally {
                    observed.push({ selected: selected.clone(), document: context.clone() });
                }
            },

            reset() {
                executor.reset?.();
            },

            dispose() {
                executor.dispose?.();
            },
        };
    };
}

const retainedSources = [
    {
        template: "CSharp",
        source: `
var selected = this.node;
this.setProperty("name", "Before reload");
this.dom.LoadXml("<Item type='ReferenceRecord'><name>Current document</name></Item>");
selected.SelectSingleNode("name").InnerText = "After detachment";
return this.getInnovator().newResult("Accepted");`,
    },
    {
        template: "CSharpInOut",
        source: `// MethodTemplateName = CSharpInOut;
var selected = inDom.DocumentElement;
selected.SelectSingleNode("name").InnerText = "Before reload";
inDom.LoadXml("<Item type='ReferenceRecord'><name>Current document</name></Item>");
selected.SelectSingleNode("name").InnerText = "After detachment";
var inn = new Innovator(InnovatorServerASP);
outDom.LoadXml(inn.newResult("Accepted").ToString());`,
    },
];

test.each(retainedSources)(
    "Method transport preserves its detached selection: $template",
    async ({ source }) => {
        await using project = await referenceProject(referenceMethod("RetainInput", source));
        const observed: RetainedInput[] = [];
        using h = await createHarness({
            cwd: project.cwd,
            executors: [retainingExecutor(observed)],
        });
        const result = await h.callMethod("RetainInput", { name: "Original" });

        expect(result.getResult()).toBe("Accepted");
        expect(observed[0]?.selected.getProperty("name")).toBe("After detachment");
        expect(observed[0]?.document.getProperty("name")).toBe("Current document");
        expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.Committed);
    },
    60_000,
);

function mutationHooks(type: string, event: string): string {
    const reload = `
var selected = this.node;
string id = this.getID();
this.setProperty("name", "Before reload");
this.loadAML("<Item type='${type}' action='update' id='" + id + "'><name>Current document</name></Item>");
selected.SelectSingleNode("name").InnerText = "Saved retained value";
return this.getInnovator().newResult("Ignored response");`;
    const inspect = `
if (this.getProperty("name") != "Current document")
{
    throw new Exception("The next mutation hook did not receive the current document");
}
this.setProperty("name", "Document-only value");
return this.getInnovator().newResult("Another ignored response");`;
    const owner = type === "ReferenceRecord" ? "REF_RECORD" : "REF_HOLDER";

    return (
        referenceMethod("ReloadMutationInput", reload) +
        referenceEvent(owner, event, "ReloadMutationInput", { order: 10 }) +
        referenceMethod("InspectMutationInput", inspect) +
        referenceEvent(owner, event, "InspectMutationInput", { order: 20 })
    );
}

test.each(["ReferenceRecord", "ReferenceHolder"])(
    "update writes its captured values while later hooks receive the current document: %s",
    async (type) => {
        await using project = await referenceProject(
            mutationHooks(type, "onBeforeUpdate"),
            'ReferenceHolder: [{ name: "Before" }],',
        );
        using h = await createHarness({ cwd: project.cwd, csharp: {} });
        const original = h.state.getOne(type, {
            name: type === "ReferenceRecord" ? "Parent" : "Before",
        });

        if (type === "ReferenceRecord") {
            await h.applyAML(`<Item type="${type}" action="lock" id="${original.id}" />`);
        }

        const result = await h.applyAML(
            `<Item type="${type}" action="update" version="0" id="${original.id}"><name>Requested</name></Item>`,
        );

        expect(result.isError()).toBe(false);
        expect(h.state.getOne(type, { id: original.id }).properties.name).toBe(
            "Saved retained value",
        );
        expect(h.state.getOne(type, { id: original.id }).properties.generation).toBe(1);
        expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.Committed);
        expect(h.executions.at(-1)?.mocks).toEqual([]);
    },
    60_000,
);

test("add saves its captured values after a before hook reloads the input document", async () => {
    await using project = await referenceProject(mutationHooks("ReferenceHolder", "onBeforeAdd"));
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const result = await h.add("ReferenceHolder", { name: "Requested" });

    expect(h.state.getOne("ReferenceHolder", { id: result.id }).properties.name).toBe(
        "Saved retained value",
    );
    expect(h.state.get("ReferenceHolder")).toHaveLength(1);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.Committed);
}, 60_000);

test("Get queries its captured criteria while later hooks see the reloaded document", async () => {
    const reload = `
var selected = this.node;
this.setProperty("name", "Child");
this.loadAML("<Item type='ReferenceRecord' action='get'><name>Other parent</name></Item>");
selected.SelectSingleNode("name").InnerText = "Parent";
return this.getInnovator().newResult("Ignored response");`;
    const inspect = `
if (this.getProperty("name") != "Other parent")
{
    throw new Exception("The next binding did not receive the current document");
}
this.setProperty("name", "Child");
return this.getInnovator().newResult("Another ignored response");`;
    const methods =
        referenceMethod("ReloadGetInput", reload) +
        referenceEvent("REF_RECORD", "onBeforeGet", "ReloadGetInput", { order: 10 }) +
        referenceMethod("InspectGetInput", inspect) +
        referenceEvent("REF_RECORD", "onBeforeGet", "InspectGetInput", { order: 20 });
    await using project = await referenceProject(methods);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const before = h.state.get("ReferenceRecord");
    const result = await h.applyAML(
        '<Item type="ReferenceRecord" action="get"><name>Child</name></Item>',
    );

    expect(result.getProperty("name")).toBe("Parent");
    expect(h.state.get("ReferenceRecord")).toEqual(before);
    expect(h.executions.at(-1)?.mocks).toEqual([]);
}, 60_000);

test("rejection transfers detached input while nested writes roll back and reset stays isolated", async () => {
    const source = `
var holder = this.newItem("ReferenceHolder", "add");
holder.setProperty("name", "Must roll back");
var saved = holder.apply();
if (saved.isError()) { throw new Exception(saved.getErrorString()); }
var selected = this.node;
this.loadAML("<Item type='ReferenceRecord'><name>Rejected document</name></Item>");
selected.SelectSingleNode("name").InnerText = "Rejected detached value";
throw new Exception("Rejected after detachment");`;
    const methods =
        referenceMethod("RejectDetachedInput", source) +
        referenceMethod(
            "ReadFreshInput",
            'return this.getInnovator().newResult(this.getProperty("name"));',
        );
    await using project = await referenceProject(methods);
    const observed: RetainedInput[] = [];
    using first = await createHarness({
        cwd: project.cwd,
        executors: [retainingExecutor(observed)],
    });
    using second = await createHarness({ cwd: project.cwd, csharp: {} });
    const before = first.state.get("ReferenceRecord");

    await expect(first.callMethod("RejectDetachedInput", { name: "Original" })).rejects.toThrow(
        "Rejected after detachment",
    );

    expect(observed[0]?.selected.getProperty("name")).toBe("Rejected detached value");
    expect(observed[0]?.document.getProperty("name")).toBe("Rejected document");
    expect(first.state.get("ReferenceHolder")).toEqual([]);
    expect(first.state.get("ReferenceRecord")).toEqual(before);
    expect(first.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);

    await first.reset();
    expect((await first.callMethod("ReadFreshInput", { name: "After reset" })).getResult()).toBe(
        "After reset",
    );
    expect((await second.callMethod("ReadFreshInput", { name: "Other world" })).getResult()).toBe(
        "Other world",
    );
    expect(first.state.get("ReferenceHolder")).toEqual([]);
    expect(second.state.get("ReferenceHolder")).toEqual([]);
}, 60_000);

test("an invalid reloaded document rejects before the next Item hook and rolls back nested writes", async () => {
    const reload = `
var holder = this.newItem("ReferenceHolder", "add");
holder.setProperty("name", "Must roll back");
var saved = holder.apply();
if (saved.isError()) { return saved; }
this.loadAML("<Result>Current scalar</Result>");
return this.getInnovator().newResult("Ignored response");`;
    const methods =
        referenceMethod("ReplaceWithScalar", reload) +
        referenceEvent("REF_RECORD", "onBeforeGet", "ReplaceWithScalar", { order: 10 }) +
        referenceMethod("MustNotExecute", 'throw new Exception("The later hook executed");') +
        referenceEvent("REF_RECORD", "onBeforeGet", "MustNotExecute", { order: 20 });
    await using project = await referenceProject(methods);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const before = h.state.get("ReferenceRecord");

    await expect(
        h.applyAML('<Item type="ReferenceRecord" action="get"><name>Parent</name></Item>'),
    ).rejects.toMatchObject({ code: "InvalidServerEventContext" });
    expect(h.state.get("ReferenceHolder")).toEqual([]);
    expect(h.state.get("ReferenceRecord")).toEqual(before);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
}, 60_000);
