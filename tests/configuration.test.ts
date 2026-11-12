import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHarness } from "../src/index.js";
import type { Fixtures } from "../src/index.js";
import { Item } from "../src/items/item.js";
import type { HarnessStorage } from "../src/storage/types.js";

const directories: string[] = [];
const schema = Bun.fileURLToPath(
    new URL("../.harness/packages/pipeline/Import/structure.xml", import.meta.url),
);

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
});

async function project(fixtures?: Fixtures): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "harness-configuration-"));
    directories.push(directory);
    await mkdir(join(directory, ".harness", "packages", "Example", "Import"), { recursive: true });
    await mkdir(join(directory, "tests"), { recursive: true });
    await Bun.write(
        join(directory, ".harness", "packages", "Example", "Import", "schema.xml"),
        Bun.file(schema),
    );
    await Bun.write(
        join(directory, ".harness", "packages", "Example", "imports.mf"),
        "This manifest must not be followed during folder discovery.",
    );

    if (fixtures) {
        await Bun.write(
            join(directory, ".harness", "fixtures.ts"),
            `export default ${JSON.stringify(fixtures)};`,
        );
    }

    return directory;
}

test("conventions find packages and fixtures from a nested test directory without config", async () => {
    const directory = await project({ TestNode: [{ name: "Convention", count: 0 }] });
    using world = await createHarness({ cwd: join(directory, "tests"), csharp: false });

    expect((await world.getOne("TestNode", { name: "Convention" })).properties.count).toBe(0);
});

test.each(["configuration", "test override"])(
    "%s package paths add to automatic packages and resolve from the configuration directory",
    async (source) => {
        const directory = await project({ TestNode: [{ name: "Automatic" }] });
        await Bun.write(
            join(directory, "vendor", "First", "Import", "data.xml"),
            '<Item type="TestNode" action="add" id="FIRST_EXTRA"><name>First extra</name></Item>',
        );
        await Bun.write(
            join(directory, "vendor", "Second", "nested", "data.xml"),
            '<Item type="TestNode" action="add" id="SECOND_EXTRA"><name>Second extra</name><parent type="TestNode">FIRST_EXTRA</parent></Item>',
        );
        const packages = ["../vendor/First", "../vendor/Second"];

        if (source === "configuration") {
            await Bun.write(
                join(directory, ".harness", "config.ts"),
                `export default { packages: ${JSON.stringify(packages)} };`,
            );
        }

        using world = await createHarness({
            cwd: join(directory, "tests"),
            csharp: false,
            ...(source === "test override" ? { packages } : {}),
        });
        expect((await world.getOne("TestNode", { name: "Automatic" })).properties.name).toBe(
            "Automatic",
        );
        expect((await world.getOne("TestNode", { name: "First extra" })).id).toBe("FIRST_EXTRA");
        expect((await world.getOne("TestNode", { name: "Second extra" })).properties.parent).toBe(
            "FIRST_EXTRA",
        );
    },
);

test("an empty additional package list still loads the conventional packages", async () => {
    const directory = await project({ TestNode: [{ name: "Automatic" }] });
    using world = await createHarness({ cwd: directory, csharp: false, packages: [] });

    expect((await world.getOne("TestNode", { name: "Automatic" })).properties.name).toBe(
        "Automatic",
    );
});

test("automatic discovery ignores imports.mf instead of importing its external targets", async () => {
    const directory = await project({ TestNode: [{ name: "Automatic" }] });
    await Bun.write(
        join(directory, ".harness", "packages", "imports.mf"),
        '<imports><package name="Outside" path="../outside.xml" /></imports>',
    );
    await Bun.write(
        join(directory, ".harness", "outside.xml"),
        '<Item type="Identity" action="add" id="OUTSIDE"><name>Outside</name></Item>',
    );
    using world = await createHarness({ cwd: directory, csharp: false });

    expect((await world.getOne("TestNode", { name: "Automatic" })).properties.name).toBe(
        "Automatic",
    );
    expect(await world.get("Identity", { id: "OUTSIDE" })).toEqual([]);
});

test("overlapping automatic and additional package inputs are imported once", async () => {
    const directory = await project({ TestNode: [{ name: "Once" }] });
    using world = await createHarness({
        cwd: directory,
        csharp: false,
        packages: ["./packages/Example/Import"],
    });

    expect(await world.get("TestNode", {})).toHaveLength(1);
});

test.each(["missing", "empty"])(
    "additional packages work when the conventional package directory is %s",
    async (state) => {
        const directory = await project({ TestNode: [{ name: "Additional" }] });
        const conventional = join(directory, ".harness", "packages");
        await rename(conventional, join(directory, "vendor"));

        if (state === "empty") {
            await mkdir(conventional);
        }

        using world = await createHarness({
            cwd: directory,
            csharp: false,
            packages: ["../vendor"],
        });

        expect((await world.getOne("TestNode", { name: "Additional" })).properties.name).toBe(
            "Additional",
        );
    },
);

test("additional paths that do not exist still fail explicitly", async () => {
    const directory = await project();

    await expect(
        createHarness({
            cwd: directory,
            csharp: false,
            packages: ["../missing-export"],
        }),
    ).rejects.toMatchObject({ code: "PackageReadFailed" });
});

test("an alternate config file keeps automatic packages in the project's .harness directory", async () => {
    const directory = await project();
    await Bun.write(
        join(directory, "vendor", "data.xml"),
        '<Item type="TestNode" action="add" id="EXTRA"><name>Extra</name></Item>',
    );
    await Bun.write(
        join(directory, "harness.config.ts"),
        'export default { packages: ["./vendor"] };',
    );
    using world = await createHarness({
        cwd: directory,
        config: "./harness.config.ts",
        csharp: false,
    });

    expect((await world.getOne("TestNode", { name: "Extra" })).id).toBe("EXTRA");
});

test("inline configuration discovers automatic packages from a nested test directory", async () => {
    const directory = await project({ TestNode: [{ name: "Automatic" }] });
    using world = await createHarness({
        cwd: join(directory, "tests"),
        config: { csharp: false },
    });

    expect((await world.getOne("TestNode", { name: "Automatic" })).properties.name).toBe(
        "Automatic",
    );
});

test("fixture directories load TypeScript files together and resolve references across files", async () => {
    const directory = await project();
    const fixtures = join(directory, ".harness", "fixtures");
    await mkdir(fixtures);
    await Bun.write(
        join(fixtures, "01-child.ts"),
        'export default { TestNode: [{ name: "Child", parent: { name: "Parent" } }] };',
    );
    await Bun.write(
        join(fixtures, "02-parent.ts"),
        'export default { TestNode: [{ name: "Parent" }] };',
    );
    using world = await createHarness({ cwd: directory, csharp: false });

    const parent = await world.getOne("TestNode", { name: "Parent" });
    expect((await world.getOne("TestNode", { name: "Child" })).properties.parent).toBe(parent.id);
});

test("fixture edits invalidate imports when the next world is created in the same Bun process", async () => {
    const directory = await project({ TestNode: [{ name: "Before" }] });
    using first = await createHarness({ cwd: directory, csharp: false });
    await Bun.write(
        join(directory, ".harness", "fixtures.ts"),
        'export default { TestNode: [{ name: "After" }] };',
    );
    using second = await createHarness({ cwd: directory, csharp: false });

    expect(await second.get("TestNode", { name: "Before" })).toEqual([]);
    expect((await second.getOne("TestNode", { name: "After" })).properties.name).toBe("After");
    expect((await first.getOne("TestNode", { name: "Before" })).properties.name).toBe("Before");
});

test("local fixture overrides replace shared inputs without altering later worlds", async () => {
    const directory = await project({ TestNode: [{ name: "Shared" }] });
    const alternate = join(directory, ".harness", "alternate.ts");
    await Bun.write(alternate, 'export default { TestNode: [{ name: "Override" }] };');

    using custom = await createHarness({
        cwd: directory,
        csharp: false,
        fixtures: ["alternate.ts"],
    });
    using shared = await createHarness({ cwd: directory, csharp: false });

    expect(await custom.get("TestNode", { name: "Shared" })).toEqual([]);
    expect(await shared.get("TestNode", { name: "Override" })).toEqual([]);
});

test("ambiguous fixture references reject setup and release the entire world", async () => {
    const directory = await project({
        TestNode: [{ name: "Duplicate" }, { name: "Duplicate" }],
        TestLink: [{ source_id: { name: "Duplicate" }, related_id: { name: "Duplicate" } }],
    });
    let captured: HarnessStorage | undefined;
    let disposals = 0;

    await expect(
        createHarness({
            cwd: directory,
            csharp: false,
            modules: [
                (storage) => {
                    captured = storage;

                    return {
                        id: "test.fixture-cleanup",

                        setup() {},

                        dispose() {
                            disposals += 1;
                        },
                    };
                },
            ],
        }),
    ).rejects.toThrow("matched 2 'TestNode' records");

    expect(disposals).toBe(1);
    expect(() => captured?.listItemTypes()).toThrow("SQLite storage is closed");
});

test("circular fixture references are connected before tests query their records", async () => {
    const directory = await project({
        TestNode: [
            { name: "First", parent: { name: "Second" } },
            { name: "Second", parent: { name: "First" } },
        ],
    });

    using world = await createHarness({ cwd: directory, csharp: false });
    const first = await world.getOne("TestNode", { name: "First" });
    const second = await world.getOne("TestNode", { name: "Second" });
    expect(first.properties.parent).toBe(second.id);
    expect(second.properties.parent).toBe(first.id);
});

test("module factories create separate state for each world and participate in reset and disposal", async () => {
    const directory = await project({ TestNode: [{ name: "Ready" }] });
    const owners: { resets: number; disposed: boolean }[] = [];
    const options = {
        cwd: directory,
        csharp: false as const,
        modules: [
            () => {
                const state = { resets: 0, disposed: false };
                owners.push(state);

                return {
                    id: "test.owned-module",

                    setup() {},

                    reset() {
                        state.resets += 1;
                    },

                    dispose() {
                        state.disposed = true;
                    },
                };
            },
        ],
    };
    const first = await createHarness(options);
    using second = await createHarness(options);

    first.reset();
    first.close();
    expect((await second.getOne("TestNode", { name: "Ready" })).properties.name).toBe("Ready");
    expect(owners).toEqual([
        { resets: 1, disposed: true },
        { resets: 0, disposed: false },
    ]);
});

test("malformed configuration reports the actual unknown key", async () => {
    const directory = await project();
    await Bun.write(join(directory, ".harness", "config.ts"), "export default { fixture: [] };");

    await expect(createHarness({ cwd: directory })).rejects.toThrow(
        "Unknown Harness configuration key 'fixture'",
    );
});

test("fixture setup skips business hooks, while a normal add runs the imported C# source", async () => {
    const directory = await project({ TestNode: [{ name: "Fixture" }] });
    const path = join(directory, ".harness", "packages", "Example", "Import", "hooks.xml");
    await Bun.write(
        path,
        `<AML>
    <Item type="Method" action="add">
      <name>ConfigureName</name>
      <method_type>C#</method_type>
      <method_code><![CDATA[this.setProperty("name", "From original C#"); return this;]]></method_code>
    </Item>
    <Item type="Server Event" action="add">
      <source_id><Item type="ItemType" action="get"><name>TestNode</name></Item></source_id>
      <related_id><Item type="Method" action="get"><name>ConfigureName</name></Item></related_id>
      <server_event>onBeforeAdd</server_event>
      <sort_order>1</sort_order>
    </Item>
  </AML>`,
    );
    using world = await createHarness({ cwd: directory });

    expect(world.trace.filter((entry) => entry.kind === "method")).toEqual([]);
    expect((await world.getOne("TestNode", { name: "Fixture" })).properties.name).toBe("Fixture");

    const added = await world.add("TestNode", { name: "Request" });
    expect(added.properties.name).toBe("From original C#");
}, 60_000);

test("C# sessions resolve real fixture users and preserve result values and property attributes", async () => {
    const directory = await project();
    const path = join(directory, ".harness", "packages", "Example", "Import", "context.xml");
    await Bun.write(
        path,
        `<AML>
    <Item type="User" action="add"><login_name>fixture-user</login_name></Item>
    <Item type="Method" action="add">
      <name>ReadContext</name>
      <method_type>C#</method_type>
      <method_code><![CDATA[
        var context = new {
          user_id = this.getInnovator().getUserID(),
          item_type = this.getAttribute("type"),
          synced = this.getPropertyAttribute("module_info", "is_synced", "missing")
        };
        return this.getInnovator().newResult(Newtonsoft.Json.JsonConvert.SerializeObject(context));
      ]]></method_code>
    </Item>
  </AML>`,
    );
    using world = await createHarness({
        cwd: directory,
        session: { user: { login_name: "fixture-user" } },
    });
    const user = await world.getOne("User", { login_name: "fixture-user" });
    const request = Item.create("ContextPayload");
    request.setPropertyAttribute("module_info", "is_synced", "1");

    const result = await world.callMethod("ReadContext", request);
    expect(JSON.parse(result.getResult())).toEqual({
        user_id: user.id,
        item_type: "ContextPayload",
        synced: "1",
    });
}, 60_000);

test("new worlds reload imported config helpers and retain each module's location", async () => {
    const directory = await project({ TestNode: [{ name: "Shared" }] });
    const setup = join(directory, ".harness");
    await Bun.write(
        join(setup, "settings.ts"),
        'export default { fixtures: ["fixtures.ts"], csharp: false };',
    );
    await Bun.write(
        join(setup, "config.ts"),
        `import settings from "./settings.ts";
    if (import.meta.dir !== ${JSON.stringify(setup)}) throw new Error("Wrong config location");
    export default settings;`,
    );
    using first = await createHarness({ cwd: directory });
    await Bun.write(
        join(setup, "alternate.ts"),
        'export default { TestNode: [{ name: "Changed" }] };',
    );
    await Bun.write(
        join(setup, "settings.ts"),
        'export default { fixtures: ["alternate.ts"], csharp: false };',
    );
    using second = await createHarness({ cwd: directory });
    expect((await first.getOne("TestNode", { name: "Shared" })).properties.name).toBe("Shared");
    expect((await second.getOne("TestNode", { name: "Changed" })).properties.name).toBe("Changed");
});

test("fixture data dependencies reload even when the fixture module itself is unchanged", async () => {
    const directory = await project();
    const setup = join(directory, ".harness");
    await Bun.write(join(setup, "data.json"), JSON.stringify({ TestNode: [{ name: "Before" }] }));
    await Bun.write(
        join(setup, "fixtures.ts"),
        'import data from "./data.json"; export default data;',
    );
    using first = await createHarness({ cwd: directory, csharp: false });
    await Bun.write(join(setup, "data.json"), JSON.stringify({ TestNode: [{ name: "After" }] }));
    using second = await createHarness({ cwd: directory, csharp: false });
    expect((await first.getOne("TestNode", { name: "Before" })).properties.name).toBe("Before");
    expect(await second.get("TestNode", { name: "Before" })).toEqual([]);
    expect((await second.getOne("TestNode", { name: "After" })).properties.name).toBe("After");
});

test("package additions, edits and deletions affect the next world", async () => {
    const directory = await project();
    const path = join(directory, ".harness", "packages", "Example", "Import", "data.xml");
    const settings = { cwd: directory, csharp: false as const };
    using empty = await createHarness(settings);
    await Bun.write(
        path,
        '<Item type="TestNode" action="add" id="IMPORTED"><name>Added</name></Item>',
    );
    using added = await createHarness(settings);
    expect((await added.getOne("TestNode", { name: "Added" })).id).toBe("IMPORTED");
    await Bun.write(
        path,
        '<Item type="TestNode" action="add" id="IMPORTED"><name>Changed</name></Item>',
    );
    using changed = await createHarness(settings);
    expect((await changed.getOne("TestNode", { name: "Changed" })).id).toBe("IMPORTED");
    await rm(path);
    using removed = await createHarness(settings);
    expect(await removed.get("TestNode", {})).toEqual([]);
    expect(await empty.get("TestNode", {})).toEqual([]);
});

test("editing authoritative is_versionable metadata changes the next world's actual mutations", async () => {
    const directory = await project({ TestNode: [{ name: "Editable" }] });
    const path = join(directory, ".harness", "packages", "Example", "Import", "schema.xml");
    const original = await Bun.file(path).text();
    await Bun.write(
        join(directory, ".harness", "fixtures", "user.xml"),
        '<Item type="User" action="add" id="DEVELOPER"><login_name>developer</login_name></Item>',
    );
    const options = {
        cwd: directory,
        csharp: false as const,
        session: { user: { login_name: "developer" } },
    };
    using unversioned = await createHarness(options);
    const first = await unversioned.getOne("TestNode", { name: "Editable" });
    expect((await unversioned.update(first, { name: "Saved in place" })).id).toBe(first.id);

    await Bun.write(
        path,
        original.replace(
            "<is_versionable>0</is_versionable>",
            "<is_versionable>1</is_versionable>",
        ),
    );
    using versioned = await createHarness(options);
    const second = await versioned.getOne("TestNode", { name: "Editable" });
    const saved = await versioned.update(second, { name: "New generation" });
    expect(saved.id).not.toBe(second.id);
    expect(saved.properties.config_id).toBe(second.id);
    expect(saved.properties.generation).toBe(2);
});

test("AML fixtures override packaged starting data and resolve references in the same setup transaction", async () => {
    const directory = await project();
    await Bun.write(
        join(directory, ".harness", "packages", "Example", "Import", "data.xml"),
        '<Item type="TestNode" action="add" id="NODE"><name>Packaged</name><parent type="TestNode">OTHER</parent></Item>',
    );
    await Bun.write(
        join(directory, ".harness", "fixtures", "records.xml"),
        `<AML>
    <Item type="TestNode" action="add" id="NODE"><name>Scenario</name></Item>
    <Item type="TestNode" action="add" id="OTHER"><name>Parent</name></Item>
  </AML>`,
    );
    using world = await createHarness({ cwd: directory, csharp: false });
    expect((await world.getOne("TestNode", { name: "Scenario" })).properties.parent).toBe("OTHER");
    expect(await world.get("TestNode", { name: "Packaged" })).toEqual([]);
});

test("factory failures dispose resources constructed before ownership transfers to the engine", async () => {
    const directory = await project();
    let disposed = 0;
    const failure = new Error("Second executor factory failed");
    await expect(
        createHarness({
            cwd: directory,
            csharp: false,
            executors: [
                () => ({
                    language: "Example",

                    execute(_definition, context) {
                        return Promise.resolve(context);
                    },

                    dispose() {
                        disposed += 1;
                    },
                }),
                () => {
                    throw failure;
                },
            ],
        }),
    ).rejects.toThrow(failure);
    expect(disposed).toBe(1);
});
