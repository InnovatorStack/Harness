import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { baselineEntries } from "../src/baseline/catalog.js";
import { isBaselineSource } from "../src/baseline/source.js";
import { createEngine } from "../src/engine.js";
import type { Engine } from "../src/engine.js";
import { createHarness } from "../src/index.js";
import { Item } from "../src/items/item.js";
import { csharp } from "../src/methods/csharp/index.js";
import { importPackageDocuments } from "../src/packages/module.js";
import { parseAml } from "../src/packages/parser.js";

const worlds: Engine[] = [];
const directories: string[] = [];

afterEach(async () => {
    for (const world of worlds.splice(0)) {
        world.close();
    }

    for (const directory of directories.splice(0)) {
        await rm(directory, { recursive: true, force: true });
    }
});

function world(): Engine {
    const engine = createEngine();
    worlds.push(engine);

    return engine;
}

function load(engine: Engine, xml: string, file = "solution.xml"): void {
    engine.runtime.executeSync(importPackageDocuments, [parseAml(`<AML>${xml}</AML>`, file)]);
}

test("new worlds contain genuine core ItemType and Property identities", () => {
    const engine = world();
    expect(engine.storage.getItemType("ItemType")?.id).toBe("450906E86E304F55A34B3C0D65C097EA");
    expect(engine.storage.getItemType("Property")?.id).toBe("26D7CD4E033242148E2724D3D054B4D3");
    expect(engine.storage.getItemType("Identity")?.id).toBe("E582AB17663F4EF28460015B2BE9E094");
    expect(engine.storage.getItemType("File")?.id).toBe("8052A558B9084D41B9F11805E464F443");
    expect(engine.storage.getItemType("Member")?.isRelationship).toBe(true);
    expect(engine.storage.getItemType("Morphae")).toMatchObject({
        id: "5ED4936039F64E9E99F703F8F46A1DB1",
        isRelationship: true,
    });
    expect(
        engine.storage
            .getItemType("ItemType")
            ?.properties.find((property) => property.name === "is_versionable"),
    ).toMatchObject({ id: "740A099AFA114E02883507C722D17B96", dataType: "boolean" });
    expect(engine.storage.listDocuments()).toEqual([]);
    expect(baselineEntries.every((entry) => isBaselineSource(entry.source))).toBe(true);
});

test("common identities, access records, revisions and default lifecycles can be fetched immediately", async () => {
    const engine = world();
    const worldIdentity = engine.inspect(engine.find("Identity", { name: "World" }));
    expect(worldIdentity.id).toBe("A73B655731924CD0B027E4F4D5FCC0A9");
    expect(worldIdentity.properties.is_alias).toBe(0);

    const admin = engine.inspect(engine.find("User", { login_name: "admin" }));
    expect(admin.id).toBe("30B991F927274FA3829655F50C99472E");
    expect(admin.properties).not.toHaveProperty("password");
    const alias = await engine.applyAML(
        `<Item type="Alias" action="get"><source_id>${admin.id}</source_id></Item>`,
    );
    expect(alias.getProperty("related_id")).toBe("DBA5D86402BF43D5976854B8B48FCDD1");

    const permission = engine.inspect(engine.find("Permission", { name: "Default Access" }));
    expect(permission.id).toBe("9122CD065CF04141B8EFE263FC80BEA4");
    expect(
        engine.storage
            .listItems("Access")
            .some((access) => access.properties.source_id === permission.id),
    ).toBe(true);
    const revision = engine.inspect(engine.find("Revision", { name: "Default" }));
    expect(revision.id).toBe("7FE395DD8B9F4E1090756A34B733D75E");
    expect(revision.properties.revision).toBe("A B C D E F G H J K L M N P Q R S T U V W X Y Z");
    const lifecycle = engine.inspect(engine.find("Life Cycle Map", { name: "Default" }));
    expect(
        engine.storage.getItem("Life Cycle State", String(lifecycle.properties.start_state))
            ?.properties.name,
    ).toBe("Released");
});

test("ordinary exports can reference built-in IDs and query their metadata without prerequisite copies", async () => {
    const engine = world();
    load(
        engine,
        `
    <Item type="ItemType" action="add" id="ASSIGNMENT_TYPE"><name>TestAssignment</name>
      <revisions type="Revision">7FE395DD8B9F4E1090756A34B733D75E</revisions>
      <Relationships>
        <Item type="Property" action="add"><name>assignee</name><data_type>item</data_type><data_source type="ItemType">45E899CD2859442982EB22BB2DF683E5</data_source></Item>
      </Relationships>
    </Item>
    <Item type="Method" action="add" id="METHOD"><name>TestMethod</name><execution_allowed_to type="Identity">A73B655731924CD0B027E4F4D5FCC0A9</execution_allowed_to></Item>
    <Item type="TestAssignment" action="add" id="ASSIGNMENT"><assignee><Item type="User" action="get"><login_name>admin</login_name></Item></assignee></Item>
  `,
    );
    const result = await engine.applyAML(
        '<Item type="TestAssignment" action="get" id="ASSIGNMENT" />',
    );
    expect(result.getProperty("assignee")).toBe("30B991F927274FA3829655F50C99472E");
    expect(
        engine.storage.getCatalogEntry("Method", "METHOD")?.properties.execution_allowed_to,
    ).toBe("A73B655731924CD0B027E4F4D5FCC0A9");
});

test("conventional package and fixture folders use the baseline without extra configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-baseline-"));
    directories.push(directory);
    await Bun.write(
        join(directory, ".harness/packages/team.xml"),
        '<Item type="Identity" action="get"><name>World</name></Item>',
    );
    await Bun.write(
        join(directory, ".harness/fixtures/users.xml"),
        '<Item type="User" action="add" id="TEST_USER"><login_name>test.developer</login_name></Item>',
    );

    using harness = await createHarness({ cwd: directory, csharp: false });
    expect(await harness.getOne("Identity", { name: "World" })).toMatchObject({
        id: "A73B655731924CD0B027E4F4D5FCC0A9",
    });
    expect(await harness.getOne("User", { login_name: "test.developer" })).toMatchObject({
        id: "TEST_USER",
    });
});

test("the public harness can start with the built-in baseline alone", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-baseline-only-"));
    directories.push(directory);
    using harness = await createHarness({ cwd: directory, csharp: false });
    expect(await harness.getOne("Identity", { name: "World" })).toMatchObject({
        id: "A73B655731924CD0B027E4F4D5FCC0A9",
    });
});

test("native additions override defaults once and later imports preserve the supplied values", () => {
    const engine = world();
    load(
        engine,
        '<Item type="Identity" action="add" id="A73B655731924CD0B027E4F4D5FCC0A9"><name>World</name><description>Local definition</description></Item>',
    );
    load(
        engine,
        '<Item type="Variable" action="add" id="LOCAL_VARIABLE"><name>Local setting</name><value>Present</value></Item>',
        "later.xml",
    );
    const identity = engine.storage.getCatalogEntry("Identity", "A73B655731924CD0B027E4F4D5FCC0A9");
    expect(identity?.properties).toMatchObject({ description: "Local definition", is_alias: 0 });
    expect(identity?.source.file).toBe("solution.xml");
    expect(() =>
        load(
            engine,
            '<Item type="Identity" action="add" id="A73B655731924CD0B027E4F4D5FCC0A9"><name>World</name></Item>',
            "duplicate.xml",
        ),
    ).toThrow("already exists");
});

test("native ItemType and Property definitions override default metadata without losing real IDs", () => {
    const engine = world();
    load(
        engine,
        `
    <Item type="ItemType" action="add" id="45E899CD2859442982EB22BB2DF683E5"><name>User</name><is_versionable>1</is_versionable></Item>
    <Item type="Property" action="add" id="740A099AFA114E02883507C722D17B96"><source_id>450906E86E304F55A34B3C0D65C097EA</source_id><name>is_versionable</name><data_type>boolean</data_type><label>Versioned</label></Item>
  `,
    );
    expect(engine.storage.getItemType("User")?.isVersionable).toBe(true);
    expect(
        engine.storage
            .getItemType("ItemType")
            ?.properties.find((property) => property.name === "is_versionable")?.id,
    ).toBe("740A099AFA114E02883507C722D17B96");
    expect(
        engine.storage.getCatalogEntry("Property", "740A099AFA114E02883507C722D17B96")?.properties
            .label,
    ).toBe("Versioned");
});

test("a different native Property ID replaces its default logical definition", () => {
    const engine = world();
    const previous = engine.storage
        .getItemType("User")
        ?.properties.find((property) => property.name === "login_name");
    expect(previous?.id).toBeDefined();
    load(
        engine,
        '<Item type="Property" action="add" id="NATIVE_LOGIN"><source_id>45E899CD2859442982EB22BB2DF683E5</source_id><name>login_name</name><data_type>string</data_type><is_required>1</is_required></Item>',
    );
    expect(
        engine.storage
            .getItemType("User")
            ?.properties.find((property) => property.name === "login_name")?.id,
    ).toBe("NATIVE_LOGIN");
    expect(engine.storage.getCatalogEntry("Property", previous?.id ?? "")).toBeUndefined();
});

test("deleting a default record does not cause a later import to resurrect it", () => {
    const engine = world();
    const value = engine.storage.listItems("Value")[0];

    if (!value) {
        throw new Error("Expected built-in list values.");
    }

    load(engine, `<Item type="Value" action="delete" id="${value.id}" />`);
    load(engine, "", "later.xml");
    expect(engine.storage.getItem("Value", value.id)).toBeUndefined();
});

test("failed imports restore baseline records and source provenance atomically", () => {
    const engine = world();
    const before = engine.storage.snapshot();
    expect(() =>
        load(
            engine,
            `
    <Item type="Identity" action="add" id="A73B655731924CD0B027E4F4D5FCC0A9"><name>World</name><description>Must roll back</description></Item>
    <Item type="Method" action="add" id="BROKEN"><name>Broken</name><execution_allowed_to type="Identity">MISSING_PREREQUISITE</execution_allowed_to></Item>
  `,
        ),
    ).toThrow("MISSING_PREREQUISITE");
    expect(engine.storage.snapshot()).toEqual(before);
    expect(
        isBaselineSource(
            engine.storage.getCatalogEntry("Identity", "A73B655731924CD0B027E4F4D5FCC0A9")?.source,
        ),
    ).toBe(true);
});

test("baseline overrides remain isolated between worlds and reset restores the checkpoint", async () => {
    const first = world();
    const second = world();
    const original = second.inspect(second.find("Identity", { name: "World" }));
    load(
        first,
        '<Item type="Identity" action="add" id="A73B655731924CD0B027E4F4D5FCC0A9"><name>World</name><description>Only this world</description></Item>',
    );
    expect(second.inspect(second.find("Identity", { name: "World" }))).toEqual(original);
    first.reset();
    expect(first.inspect(first.find("Identity", { name: "World" }))).toEqual(original);
});

test("unsupported platform storage remains visible as metadata and fails explicitly when executed", async () => {
    const engine = world();
    const metadata = engine.inspect(engine.find("ItemType", { name: "CommandBarItem" }));
    expect(metadata.properties.implementation_type).toBe("polymorphic");
    expect(engine.storage.getItemType("CommandBarItem")).toBeUndefined();
    await expect(engine.apply(Item.create("CommandBarItem", "get"))).rejects.toThrow(
        "requires an adapter",
    );
    expect(engine.storage.getItemType("Part")).toBeUndefined();
    expect(() =>
        load(
            engine,
            '<Item type="Method" action="add" id="MISSING"><name>Unresolved</name><execution_allowed_to type="Identity">SOLUTION_IDENTITY</execution_allowed_to></Item>',
        ),
    ).toThrow("SOLUTION_IDENTITY");
});

test("real C# Methods can query built-in records through the ordinary action pipeline", async () => {
    const engine = createEngine({ executors: [csharp()] });
    worlds.push(engine);
    load(
        engine,
        `<Item type="Method" action="add" id="LOOKUP_WORLD">
    <name>TestLookupWorld</name><method_type>C#</method_type>
    <method_code><![CDATA[
      var query = this.getInnovator().newItem("Identity", "get");
      query.setProperty("name", "World");
      return query.apply();
    ]]></method_code>
  </Item>`,
    );
    const result = await engine.callMethod("TestLookupWorld", Item.create("Method"));
    expect(result.getID()).toBe("A73B655731924CD0B027E4F4D5FCC0A9");
    expect(result.getProperty("name")).toBe("World");
    expect(
        engine.trace.some((event) => event.kind === "action" && event.name === "Identity.get"),
    ).toBe(true);
});
