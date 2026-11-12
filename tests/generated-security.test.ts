import { expect, test } from "bun:test";

import { AuthorizationMode, createHarness, ExecutionOutcome } from "../src/index.js";
import { classificationProject } from "./helpers/classifications.js";
import { generatedUpdateSources } from "./helpers/generated-updates.js";
import { referenceEvent, referenceMethod, referenceProject } from "./helpers/references.js";

const replacement = `// MethodTemplateName = CSharpInOut;
var input = inDom.DocumentElement ?? throw new Exception("Missing update context");
if (!String.IsNullOrEmpty(input.GetAttribute("oldId")))
{
    var innovator = new Innovator(InnovatorServerASP);
    var query = innovator.newItem("ClassificationRecord", "get");
    query.setAttribute("idlist", input.GetAttribute("idlist"));
    var records = query.apply();
    if (records.isError()) { throw new Exception(records.getErrorString()); }

    for (int index = 0; index < records.getItemCount(); index++)
    {
        var record = records.getItemByIndex(index);
        if (record.getProperty("name") != "Will restrict") { continue; }
        var promotion = innovator.newItem("ClassificationRecord", "promoteItem");
        promotion.setID(record.getID());
        promotion.setProperty("state", "Design review");
        var result = promotion.apply();
        if (result.isError()) { throw new Exception(result.getErrorString()); }
    }

    if (input.SelectSingleNode("name")?.InnerText == "Skip base")
    {
        outDom.LoadXml("<Result>Owned by replacement</Result>");
        return;
    }
}
eventData.BaseUpdateItem(outDom);
`;

const source = `
    ${generatedUpdateSources(false, replacement, "CLASS_RECORD")}
    <Item type="Life Cycle State" action="edit" id="CLASS_DESIGN_REVIEW">
        <state_permission_id>SEC_READ</state_permission_id></Item>
    ${referenceMethod("ObserveGeneratedAccess", "return this;")}
    ${referenceEvent("CLASS_RECORD", "onBeforeUpdate", "ObserveGeneratedAccess")}
`;

const fixtures = `ClassificationRecord: [
    { name: "Allowed first", classification: "Design/Mechanical", permission_id: { name: "SEC_EDIT" } },
    { name: "Will restrict", classification: "Design/Mechanical", permission_id: { name: "SEC_EDIT" } },
],`;

test("generated base authorizes the whole captured batch after replacement side effects", async () => {
    await using project = await classificationProject(source, { versionable: true, fixtures });
    using h = await createHarness({
        cwd: project.cwd,
        authorization: AuthorizationMode.Native,
        csharp: {},
    });
    const first = h.state.getOne("ClassificationRecord", { name: "Allowed first" });
    const second = h.state.getOne("ClassificationRecord", { name: "Will restrict" });
    const before = h.state.get("ClassificationRecord");
    const result = await h.applyAML(
        `<Item type="ClassificationRecord" action="edit" idlist="${first.id},${second.id}"><name>Save batch</name></Item>`,
    );

    expect(result.getErrorCode()).toBe("PermissionDenied");
    expect(h.state.get("ClassificationRecord")).toEqual(before);
    expect(
        h.trace.filter(
            (event) => event.kind === "method" && event.name === "ObserveGeneratedAccess",
        ),
    ).toHaveLength(1);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
    expect(h.executions.at(-1)?.changes.filter((change) => change.name === "version")).toHaveLength(
        2,
    );
    expect(h.executions.at(-1)?.changes.some((change) => change.name === "promote")).toBe(true);
    expect(h.executions.at(-1)?.changes.some((change) => change.name === "update")).toBe(false);
}, 60_000);

test("base update captures lifecycle state after initial replacement side effects", async () => {
    const code = `// MethodTemplateName = CSharpInOut;
        var input = inDom.DocumentElement ?? throw new Exception("Missing input");
        if (String.IsNullOrEmpty(input.GetAttribute("oldId"))) {
            var innovator = new Innovator(InnovatorServerASP);
            var promotion = innovator.newItem("ClassificationRecord", "promoteItem");
            promotion.setID(input.GetAttribute("id"));
            promotion.setProperty("state", "Design review");
            var result = promotion.apply();
            if (result.isError()) { throw new Exception(result.getErrorString()); }
        }
        eventData.BaseUpdateItem(outDom);
    `;
    await using project = await classificationProject(
        generatedUpdateSources(false, code, "CLASS_RECORD"),
        { versionable: true },
    );
    using h = await createHarness({
        cwd: project.cwd,
        authorization: AuthorizationMode.Native,
        csharp: {},
    });
    const parent = h.state.getOne("ClassificationRecord", { name: "Start" });
    const baseline = h.state.get("ClassificationRecord");
    const result = await h.applyAML(
        `<Item type="ClassificationRecord" action="edit" id="${parent.id}"><classification>Operations</classification></Item>`,
    );

    expect(result.getErrorCode()).toBe("ClassificationCannotBeChanged");
    expect(h.state.get("ClassificationRecord")).toEqual(baseline);
    expect(h.executions.at(-1)?.changes.some((change) => change.name === "promote")).toBe(true);
    expect(h.executions.at(-1)?.changes.some((change) => change.name === "version")).toBe(false);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
}, 60_000);

test("custom action policies observe generated updates before their replacement executes", async () => {
    await using project = await referenceProject(generatedUpdateSources());
    let intercepted = false;
    using h = await createHarness({
        cwd: project.cwd,
        csharp: {},

        authorization(request) {
            if (request.kind === "action" && request.item?.getAttribute("oldId")) {
                intercepted = true;

                throw new Error("Custom generated action rejected");
            }
        },
    });
    const parent = h.state.getOne("ReferenceRecord", { name: "Parent" });
    const baseline = h.state.get("ReferenceRecord");

    await expect(
        h.applyAML(`<Item type="ReferenceRecord" action="edit" id="${parent.id}" />`),
    ).rejects.toThrow("Custom generated action rejected");
    expect(intercepted).toBe(true);
    expect(h.state.get("ReferenceRecord")).toEqual(baseline);
    expect(h.state.get("ReplacementAudit")).toEqual([]);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
}, 60_000);

test("generated replacements do not check skipped base mutations or force pending data writes", async () => {
    await using project = await classificationProject(source, { versionable: true, fixtures });
    using h = await createHarness({
        cwd: project.cwd,
        authorization: AuthorizationMode.Native,
        csharp: {},
    });
    const first = h.state.getOne("ClassificationRecord", { name: "Allowed first" });
    const second = h.state.getOne("ClassificationRecord", { name: "Will restrict" });
    const result = await h.applyAML(
        `<Item type="ClassificationRecord" action="version" idlist="${first.id},${second.id}"><name>Skip base</name></Item>`,
    );
    const current = h.state.getOne("ClassificationRecord", { config_id: second.id, is_current: 1 });

    expect(result.getResult()).toBe("Owned by replacement");
    expect(current.properties).toMatchObject({ name: "Will restrict", state: "Design review" });
    expect(current.properties.permission_id).toBe(
        h.state.getOne("Permission", { name: "SEC_READ" }).id,
    );
    expect(current.properties.locked_by_id).toBeTruthy();
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.Committed);
    expect(h.executions.at(-1)?.changes.some((change) => change.name === "update")).toBe(false);
}, 60_000);
