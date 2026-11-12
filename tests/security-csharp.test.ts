import { expect, test } from "bun:test";

import { AuthorizationMode, createHarness, seededIds } from "../src/index.js";
import { referenceEvent, referenceMethod } from "./helpers/references.js";
import { securityProject } from "./helpers/security.js";

const protectedMethod = referenceMethod("PublisherOnly", "return this;").replace(
    "</method_type>",
    "</method_type><execution_allowed_to>SEC_PUBLISHERS</execution_allowed_to>",
);

const reviseSource = `
var identity = Aras.Server.Security.Identity.GetByName("Test publishers");
using (CCO.Permissions.GrantIdentity(identity))
{
    var item = this.newItem("SecurityDocument", "get");
    item.setProperty("name", "Publish controlled");
    item = item.apply();
    if (item.isNew() || item.getAttribute("isTemp") == "1")
    {
        throw new Exception("A fetched Item cannot be new");
    }

    item = item.apply("version");
    if (item.isError())
    {
        return item;
    }

    return item.apply("unlock");
}`;

test("real C# identity grants authorize nested versioning and restricted event Methods then leave the session", async () => {
    const source =
        protectedMethod +
        referenceMethod("PublishDocument", reviseSource) +
        referenceEvent("SEC_DOCUMENT", "onBeforeVersion", "PublisherOnly");
    await using project = await securityProject(source);
    using h = await createHarness({
        cwd: project.cwd,
        authorization: AuthorizationMode.Native,
        csharp: {},
    });
    const before = await h.getOne("SecurityDocument", { name: "Publish controlled" });
    const result = await h.callMethod("PublishDocument");

    expect(result.isError()).toBe(false);
    expect(result.getID()).not.toBe(before.id);
    expect(result.node.properties).toMatchObject({
        generation: 2,
        config_id: before.id,
        locked_by_id: null,
    });
    expect((await h.callMethod("PublisherOnly")).getErrorCode()).toBe("PermissionDenied");
    expect(
        h.trace.some(
            (event) => event.kind === "authorization" && event.name.includes("Grant Identity"),
        ),
    ).toBe(true);
}, 60_000);

test("nested duplicate grants dispose independently and never remove base memberships", async () => {
    const code = `
var identity = Aras.Server.Security.Identity.GetByName("Test publishers");
if (identity == null) throw new Exception("Missing test identity");
using (CCO.Permissions.GrantIdentity(identity))
{
    using (CCO.Permissions.GrantIdentity(identity)) { }
    if (!CCO.Permissions.IdentityListHasId(CCO.Permissions.IdentitiesList, identity.Id))
    {
        throw new Exception("The outer grant disappeared");
    }
}

if (CCO.Permissions.IdentityListHasId(CCO.Permissions.IdentitiesList, identity.Id))
{
    throw new Exception("A disposed identity leaked");
}
return this.getInnovator().newResult(CCO.Permissions.IdentitiesList);`;
    await using project = await securityProject(referenceMethod("NestedGrants", code));
    using h = await createHarness({
        cwd: project.cwd,
        authorization: AuthorizationMode.Native,
        csharp: {},
    });
    const result = await h.callMethod("NestedGrants");

    expect(result.getResult().split(",")).toContain("SEC_ALIAS");
    expect(result.getResult().split(",")).toContain("SEC_EDITORS");
    expect(result.getResult().split(",")).toContain("SEC_READERS");
    expect(result.getResult().split(",")).not.toContain("SEC_PUBLISHERS");
}, 60_000);

test("forgotten grants are removed after both successful returns and C# exceptions", async () => {
    const grant =
        'CCO.Permissions.GrantIdentity(Aras.Server.Security.Identity.GetByName("Test publishers"));';
    const source =
        protectedMethod +
        referenceMethod("ForgetGrant", `${grant} return this;`) +
        referenceMethod("FailWithGrant", `${grant} throw new Exception("Source failed");`);
    await using project = await securityProject(source);
    using h = await createHarness({
        cwd: project.cwd,
        authorization: AuthorizationMode.Native,
        csharp: {},
    });
    await h.callMethod("ForgetGrant");

    expect((await h.callMethod("PublisherOnly")).getErrorCode()).toBe("PermissionDenied");
    await expect(h.callMethod("FailWithGrant")).rejects.toThrow("Source failed");
    expect((await h.callMethod("PublisherOnly")).getErrorCode()).toBe("PermissionDenied");
    h.reset();
    expect((await h.callMethod("PublisherOnly")).getErrorCode()).toBe("PermissionDenied");
}, 60_000);

test("CCO error lookup formats imported UserMessage text through the normal query pipeline", async () => {
    const source = referenceMethod(
        "RequiredError",
        'return this.getInnovator().newError(CCO.ErrorLookup.Lookup("Test_Required", "module"));',
    );
    await using project = await securityProject(source);
    using h = await createHarness({
        cwd: project.cwd,
        authorization: AuthorizationMode.Native,
        csharp: {},
    });
    const result = await h.callMethod("RequiredError");

    expect(result.getErrorString()).toBe("A value is required for module.");
    expect(
        h.trace.some((event) => event.kind === "action" && event.name === "UserMessage.get"),
    ).toBe(true);
}, 60_000);

test("native newItem flags and getNewID share the controlled ID stream and restore on reset", async () => {
    const code = `
var item = this.newItem("SecurityDocument", "add");
if (!item.isNew() || item.getAttribute("isTemp") != "1" || item.getID().Length != 32)
{
    throw new Exception("Constructor state is wrong");
}
item.setProperty("name", "Created by C#");
var created = item.apply("add");
if (created.isNew() || created.getID() != item.getID())
{
    throw new Exception("Apply must return a separate persisted Item");
}
created.setProperty("unused_id", this.getInnovator().getNewID());
return created;`;
    await using project = await securityProject(referenceMethod("CreateWithFlags", code));
    using h = await createHarness({
        cwd: project.cwd,
        authorization: AuthorizationMode.Native,
        ids: seededIds("native-constructors"),
        csharp: {},
    });
    const first = await h.callMethod("CreateWithFlags");
    const unused = first.getProperty("unused_id");
    h.reset();
    const repeated = await h.callMethod("CreateWithFlags");

    expect(repeated.getID()).toBe(first.getID());
    expect(repeated.getProperty("unused_id")).toBe(unused);
    expect(
        h.state.getOne("SecurityDocument", { id: repeated.getID() }).properties,
    ).not.toHaveProperty("unused_id");
}, 60_000);

test("changing access needs a grant and a Permission declared for the ItemType", async () => {
    const code = `
using (CCO.Permissions.GrantIdentity(Aras.Server.Security.Identity.GetByName("Test publishers")))
{
    var item = this.newItem("SecurityDocument", "get");
    item.setProperty("name", "Publish controlled");
    item = item.apply();
    item.setProperty("permission_id", this.getProperty("target"));
    return item.apply("edit");
}`;
    await using project = await securityProject(referenceMethod("ChangeAccess", code));
    using h = await createHarness({
        cwd: project.cwd,
        authorization: AuthorizationMode.Native,
        csharp: {},
    });
    const before = h.state.get("SecurityDocument");
    const rejected = await h.callMethod("ChangeAccess", { target: "SEC_HIDDEN" });

    expect(rejected.getErrorCode()).toBe("PermissionDenied");
    expect(h.state.get("SecurityDocument")).toEqual(before);
    const accepted = await h.callMethod("ChangeAccess", { target: "SEC_READ" });

    expect(accepted.isError()).toBe(false);
    expect(
        h.state.getOne("SecurityDocument", { id: accepted.getID() }).properties.permission_id,
    ).toBe("SEC_READ");
}, 60_000);

test("worker timeout removes forgotten grants before the next invocation", async () => {
    const code = `
CCO.Permissions.GrantIdentity(Aras.Server.Security.Identity.GetByName("Test publishers"));
System.Threading.Thread.Sleep(10000);
return this;`;
    await using project = await securityProject(
        protectedMethod + referenceMethod("TimeoutGrant", code),
    );
    using h = await createHarness({
        cwd: project.cwd,
        authorization: AuthorizationMode.Native,
        csharp: { timeoutMs: 2000 },
    });
    await expect(h.callMethod("TimeoutGrant")).rejects.toMatchObject({ code: "MethodTimeout" });

    expect((await h.callMethod("PublisherOnly")).getErrorCode()).toBe("PermissionDenied");
    h.reset();
    expect((await h.callMethod("PublisherOnly")).getErrorCode()).toBe("PermissionDenied");
}, 60_000);
