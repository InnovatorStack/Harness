import { expect, test } from "bun:test";

import { AuthorizationMode, createHarness, ExecutionOutcome } from "../src/index.js";
import { noPublisherGrant, restrictedMethod } from "./helpers/bound-methods.js";
import { referenceEvent } from "./helpers/references.js";
import { securityProject } from "./helpers/security.js";

const lifecycle = `<Item type="Life Cycle Map" action="add" id="BOUND_LIFECYCLE">
    <name>Bound Method lifecycle</name><start_state>BOUND_DRAFT</start_state><Relationships>
        <Item type="Life Cycle State" action="add" id="BOUND_DRAFT"><name>Draft</name></Item>
        <Item type="Life Cycle State" action="add" id="BOUND_REVIEW"><name>Review</name></Item>
        <Item type="Life Cycle Transition" action="add" id="BOUND_TRANSITION">
            <from_state>BOUND_DRAFT</from_state><to_state>BOUND_REVIEW</to_state>
            <role>SEC_EDITORS</role><execute_post_in_main_txn>1</execute_post_in_main_txn>
        </Item>
    </Relationships>
</Item><Item type="ItemType Life Cycle" action="add">
    <source_id>SEC_DOCUMENT</source_id><related_id>BOUND_LIFECYCLE</related_id>
</Item>`;

function transitionMethod(property: "pre_action" | "post_action"): string {
    const method = restrictedMethod("RestrictedTransition", `${noPublisherGrant} return this;`);

    return `${lifecycle}${method}
        <Item type="Life Cycle Transition" action="edit" id="BOUND_TRANSITION">
            <${property}>REF_RestrictedTransition</${property}>
        </Item>`;
}

const promotionHook =
    restrictedMethod(
        "PromoteFromHook",
        `
    ${noPublisherGrant}
    var promotion = this.newItem(this.getType(), "promoteItem");
    promotion.setID(this.getID());
    promotion.setProperty("state", "Review");
    var result = promotion.apply();
    if (result.isError()) { return result; }
    this.setProperty("name", "Saved through the bound chain");
    return this;
`,
    ) + referenceEvent("SEC_DOCUMENT", "onBeforeUpdate", "PromoteFromHook");

test.each(["pre_action", "post_action"] as const)(
    "a direct promotion checks its %s Method and rolls back a denial",
    async (property) => {
        await using project = await securityProject(transitionMethod(property));
        using h = await createHarness({
            cwd: project.cwd,
            authorization: AuthorizationMode.Native,
            csharp: {},
        });
        const original = h.state.getOne("SecurityDocument", { name: "Editable" });
        const baseline = h.state.get("SecurityDocument");
        const result =
            await h.applyAML(`<Item type="SecurityDocument" action="promoteItem" id="${original.id}">
            <state>Review</state></Item>`);

        expect(result.getErrorCode()).toBe("PermissionDenied");
        expect(h.state.get("SecurityDocument")).toEqual(baseline);
        expect(h.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
        expect(
            h.trace.some(
                (entry) => entry.kind === "execution" && entry.name === "RestrictedTransition",
            ),
        ).toBe(false);
    },
);

test.each(["pre_action", "post_action"] as const)(
    "a %s Method inherits NoCheck when promotion descends from a bound hook",
    async (property) => {
        await using project = await securityProject(transitionMethod(property) + promotionHook);
        using h = await createHarness({
            cwd: project.cwd,
            authorization: AuthorizationMode.Native,
            csharp: {},
        });
        const original = h.state.getOne("SecurityDocument", { name: "Editable" });
        const result = await h.applyAML(
            `<Item type="SecurityDocument" action="edit" version="0" id="${original.id}" />`,
        );

        expect(result.isError()).toBe(false);
        expect(h.state.getOne("SecurityDocument", { id: original.id }).properties).toMatchObject({
            state: "Review",
            name: "Saved through the bound chain",
            generation: 1,
        });
        expect(
            h.trace.some(
                (entry) => entry.kind === "execution" && entry.name === "RestrictedTransition",
            ),
        ).toBe(true);
        expect((await h.callMethod("RestrictedTransition")).getErrorCode()).toBe(
            "PermissionDenied",
        );
    },
    60_000,
);

test("inherited Method NoCheck cannot bypass a lifecycle transition's role", async () => {
    const restriction = `<Item type="Life Cycle Transition" action="edit" id="BOUND_TRANSITION">
        <role>SEC_PUBLISHERS</role></Item>`;
    await using project = await securityProject(
        transitionMethod("pre_action") + restriction + promotionHook,
    );
    using h = await createHarness({
        cwd: project.cwd,
        authorization: AuthorizationMode.Native,
        csharp: {},
    });
    const original = h.state.getOne("SecurityDocument", { name: "Editable" });
    const baseline = h.state.get("SecurityDocument");
    const result = await h.applyAML(
        `<Item type="SecurityDocument" action="edit" version="0" id="${original.id}" />`,
    );

    expect(result.getErrorCode()).toBe("PermissionDenied");
    expect(h.state.get("SecurityDocument")).toEqual(baseline);
    expect(
        h.trace.some((entry) => entry.kind === "execution" && entry.name === "PromoteFromHook"),
    ).toBe(true);
    expect(
        h.trace.some(
            (entry) => entry.kind === "execution" && entry.name === "RestrictedTransition",
        ),
    ).toBe(false);
});
