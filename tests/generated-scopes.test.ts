import { expect, test } from "bun:test";

import { createHarness, seededIds } from "../src/index.js";
import type { Item } from "../src/items/item.js";
import type { MethodExecutor, MethodServerEvent } from "../src/methods/types.js";
import { generatedUpdateSources } from "./helpers/generated-updates.js";
import { referenceEvent, referenceMethod, referenceProject } from "./helpers/references.js";

test("generated base ports expire after success and reset without leaking across worlds", async () => {
    await using project = await referenceProject(generatedUpdateSources());
    const retained: { port: MethodServerEvent; item: Item }[] = [];
    const options = {
        cwd: project.cwd,
        ids: seededIds("generated-scope-test"),
        executors: [
            (): MethodExecutor => ({
                language: "C#",

                async execute(_method, item, ports) {
                    const port = ports.serverEvent;

                    if (!port) {
                        throw new Error("A replacement must own its base delegate.");
                    }

                    retained.push({ port, item: item.clone() });

                    return await port.applyBase(item);
                },
            }),
        ],
    };
    using h = await createHarness(options);
    using other = await createHarness({ ...options, ids: seededIds("generated-scope-test") });
    const parent = h.state.getOne("ReferenceRecord", { name: "Parent" });
    const baseline = h.state.get("ReferenceRecord");
    const saved = await h.update(await h.getOne("ReferenceRecord", { id: parent.id }), {
        name: "Saved",
    });

    expect(retained).toHaveLength(2);
    expect(retained[1]?.item.getAttribute("oldId")).toBe(parent.id);
    expect(other.state.get("ReferenceRecord")).toEqual(baseline);
    h.reset();
    expect(h.state.get("ReferenceRecord")).toEqual(baseline);

    for (const { port, item } of retained) {
        expect(() => port.applyBase(item)).toThrow();
    }

    const repeated = await h.update(await h.getOne("ReferenceRecord", { id: parent.id }), {
        name: "Saved again",
    });
    expect(repeated.id).toBe(saved.id);
    expect(other.state.get("ReferenceRecord")).toEqual(baseline);
});

test("generated base retains captured event suppression and response mode", async () => {
    const code = `// MethodTemplateName = CSharpInOut;
        var input = inDom.DocumentElement ?? throw new Exception("Missing update context");
        if (!String.IsNullOrEmpty(input.GetAttribute("oldId"))) {
            input.SetAttribute("serverEvents", "1");
            input.SetAttribute("doGetItem", "1");
        }
        eventData.BaseUpdateItem(outDom);
        if (input.GetAttribute("serverEvents") != "0" || input.GetAttribute("doGetItem") != "0") {
            throw new Exception("Captured base flags did not reach the live input");
        }
    `;
    const source =
        generatedUpdateSources(true, code) +
        referenceMethod("UnexpectedOptional", 'throw new Exception("Optional update ran");') +
        referenceEvent("REF_RECORD", "onBeforeUpdate", "UnexpectedOptional");
    await using project = await referenceProject(source);
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const parent = h.state.getOne("ReferenceRecord", { name: "Parent" });
    const result = await h.applyAML(
        `<Item type="ReferenceRecord" action="edit" id="${parent.id}" serverEvents="0" doGetItem="0"><name>Saved</name></Item>`,
    );

    expect(result.isError()).toBe(false);
    expect(result.node.properties).toEqual({});
    expect(h.state.getOne("ReferenceRecord", { id: result.getID() }).properties.name).toBe("Saved");
    expect(h.trace.some((event) => event.name === "UnexpectedOptional")).toBe(false);
}, 60_000);
