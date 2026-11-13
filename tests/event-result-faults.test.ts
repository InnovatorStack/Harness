import { expect, test } from "bun:test";

import { createHarness, ExecutionOutcome } from "../src/index.js";
import { ServerEventVersion } from "../src/platform/events/types.js";
import { referenceEvent, referenceMethod, referenceProject } from "./helpers/references.js";

const writeNote = `
var note = this.newItem("ReferenceHolder", "add");
note.setProperty("name", "Attempted hook write");
var saved = note.apply();
if (saved.isError()) { return saved; }
`;
const missingItems = `
var query = this.newItem("ReferenceHolder", "get");
query.setProperty("name", "Missing");
return query.apply();`;
const events = [
    { name: "onAfterUpdate", version: ServerEventVersion.Item },
    { name: "onAfterUpdate", version: ServerEventVersion.Collection },
    { name: "onAfterVersion", version: ServerEventVersion.Item },
    { name: "onAfterAdd", version: ServerEventVersion.Collection },
];
const profiles = events.flatMap((event) => [false, true].map((zero) => ({ ...event, zero })));

test.each(profiles)(
    "ordinary event faults preserve their Method origin and roll back nested writes: %j",
    async ({ name, version, zero }) => {
        const response = zero
            ? missingItems
            : 'return this.getInnovator().newError("Event rejected");';
        await using project = await referenceProject(
            referenceMethod("RejectEventResponse", writeNote + response) +
                referenceEvent("REF_RECORD", name, "RejectEventResponse", { version }),
        );
        using h = await createHarness({ cwd: project.cwd, csharp: {} });
        const before = h.state.get("ReferenceRecord");
        const parent = h.state.getOne("ReferenceRecord", { name: "Parent" });
        const action = name === "onAfterAdd" ? "add" : "edit";
        const selector = action === "add" ? "" : `id="${parent.id}"`;
        const result =
            await h.applyAML(`<Item type="ReferenceRecord" action="${action}" ${selector}>
            <name>Requested</name></Item>`);
        const run = h.executions.at(-1);

        expect(result.isError()).toBe(true);

        if (zero) {
            expect(result.getErrorCode()).toBe("0");
        } else {
            expect(result.getErrorString()).toBe("Event rejected");
        }

        expect(run?.outcome).toBe(ExecutionOutcome.RolledBack);
        expect(run?.error?.callChain.some((frame) => frame.name === "RejectEventResponse")).toBe(
            true,
        );
        expect(run?.changes.some((change) => change.name === "add")).toBe(true);
        expect(h.state.get("ReferenceRecord")).toEqual(before);
        expect(h.state.get("ReferenceHolder")).toEqual([]);
    },
    60_000,
);

test("a mocked zero-code event fault rejects without compiling its source", async () => {
    await using project = await referenceProject(
        referenceMethod("MockedEventFault", "Uncompilable original source") +
            referenceEvent("REF_RECORD", "onAfterVersion", "MockedEventFault"),
    );
    using h = await createHarness({
        cwd: project.cwd,
        mocks: [
            { method: "MockedEventFault", response: { error: "Mocked event fault", code: "0" } },
        ],
    });
    const parent = h.state.getOne("ReferenceRecord", { name: "Parent" });
    const before = h.state.get("ReferenceRecord");
    const result = await h.applyAML(`<Item type="ReferenceRecord" action="edit" id="${parent.id}">
        <name>Requested</name></Item>`);

    expect(result.getErrorCode()).toBe("0");
    expect(result.getErrorString()).toBe("Mocked event fault");
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
    expect(h.executions.at(-1)?.mocks).toHaveLength(1);
    expect(h.state.get("ReferenceRecord")).toEqual(before);
});

test("a hook can handle a nested ordinary Method's no-items result before returning success", async () => {
    const hook = `
var result = this.getInnovator().applyMethod("ReturnMissingItems", "");
if (!result.isError() || result.getErrorCode() != "0")
{
    return this.getInnovator().newError("Expected a handled no-items result");
}
this.setProperty("name", "Handled no items");
return this.getInnovator().newResult("Separate success");`;
    await using project = await referenceProject(
        referenceMethod("ReturnMissingItems", missingItems) +
            referenceMethod("HandleNestedResult", hook) +
            referenceEvent("REF_RECORD", "onBeforeVersion", "HandleNestedResult"),
    );
    using h = await createHarness({ cwd: project.cwd, csharp: {} });
    const parent = await h.getOne("ReferenceRecord", { name: "Parent" });
    const result = await h.update(parent, { name: "Requested" });

    expect(result.properties.name).toBe("Handled no items");
    expect(result.properties.generation).toBe(2);
    expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.Committed);
}, 60_000);
