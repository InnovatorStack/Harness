import { afterEach, expect, test } from "bun:test";

import { createEngine } from "../src/engine.js";
import type { Engine } from "../src/engine.js";
import { Item } from "../src/items/item.js";
import { csharp } from "../src/methods/csharp/executor.js";
import { importPackageDocuments } from "../src/packages/module.js";
import { parseAml } from "../src/packages/parser.js";

const worlds: Engine[] = [];
const structure = Bun.fileURLToPath(
    new URL("../.harness/packages/pipeline/Import/structure.xml", import.meta.url),
);
afterEach(() => {
    for (const world of worlds.splice(0)) {
        world.close();
    }
});

async function create(): Promise<Engine> {
    const world = createEngine({ executors: [csharp()] });
    worlds.push(world);
    await world.loadPackages([structure]);

    return world;
}

function method(name: string, code: string): string {
    return `<Item type="Method" action="add"><name>${name}</name><method_type>C#</method_type><method_code><![CDATA[${code}]]></method_code></Item>`;
}

function event(event: string, name: string): string {
    return `<Item type="Server Event" action="add"><source_id><Item type="ItemType" action="get"><name>TestNode</name></Item></source_id><related_id><Item type="Method" action="get"><name>${name}</name></Item></related_id><server_event>${event}</server_event><sort_order>10</sort_order><event_version>version_1</event_version></Item>`;
}

function load(world: Engine, xml: string): void {
    world.runtime.executeSync(importPackageDocuments, [
        parseAml(`<AML>${xml}</AML>`, "managed-conformance.xml"),
    ]);
}

test("original C# before-event mutations affect the actual database operation", async () => {
    const world = await create();
    const code = 'this.setProperty("name", "From original C#"); return this;';
    load(world, method("BeforeAdd", code) + event("onBeforeAdd", "BeforeAdd"));
    const add = Item.create("TestNode", "add");
    add.setProperty("name", "Initial");
    const result = await world.apply(add);
    expect(result.isError()).toBe(false);
    expect(
        world.inspect(world.find("TestNode", { name: "From original C#" })).properties.name,
    ).toBe("From original C#");
    expect(world.trace.find((entry) => entry.kind === "method")?.sourceHash).toBe(
        new Bun.CryptoHasher("sha256").update(code).digest("hex"),
    );
}, 60_000);

test("C# to item action to nested C# event reenters without deadlock", async () => {
    const world = await create();
    load(
        world,
        method("Outer", 'Item query = this.newItem("TestNode", "get"); return query.apply();') +
            method("BeforeGet", 'this.setProperty("name", "Chosen"); return this;') +
            event("onBeforeGet", "BeforeGet"),
    );
    world.seed("TestNode", { name: "Chosen" });
    world.seed("TestNode", { name: "Other" });
    const result = await world.callMethod("Outer", Item.create("TestNode"));
    expect(result.getItemCount()).toBe(1);
    expect(result.getProperty("name")).toBe("Chosen");
    const calls = world.trace.filter((entry) => entry.kind === "method");
    expect(calls.map((entry) => entry.name)).toEqual(["Outer", "BeforeGet"]);
    expect(new Set(calls.map((entry) => entry.requestId)).size).toBe(1);
}, 60_000);

test("C# Methods can inspect live AML property nodes and parse JSON columns", async () => {
    const world = await create();
    load(
        world,
        method(
            "ReadJsonColumns",
            `
      var columns = this.node.SelectNodes("./*[not(name()='Relationships')]");
      var output = new Newtonsoft.Json.Linq.JObject();
      for (int index = 0; index < columns.Count; index++) {
          var column = columns[index];
          output[column.Name] = Newtonsoft.Json.Linq.JToken.Parse(column.InnerText);
      }

      this.setProperty("activities", "[]");
      output["updated_activities"] = Newtonsoft.Json.Linq.JToken.Parse(columns[0].InnerText);
      return this.getInnovator().newResult(output.ToString());
      `,
        ),
    );
    const context = Item.create("SQL");
    context.setProperty("activities", '[{"state":"Not Started"}]');
    context.setProperty("specifications", "[]");
    context.addRelationship(Item.create("Unrelated"));

    const result = await world.callMethod("ReadJsonColumns", context);

    expect(JSON.parse(result.getResult())).toEqual({
        activities: [{ state: "Not Started" }],
        specifications: [],
        updated_activities: [],
    });
}, 60_000);

test("caught unsupported SQL cannot turn a partial C# execution into a passing test", async () => {
    const world = await create();
    load(
        world,
        method(
            "UnsupportedSql",
            `
    Item add = this.newItem("TestNode", "add"); add.setProperty("name", "Temporary"); add.apply();
    try { this.getInnovator().applySQL("SELECT 1"); } catch (Exception) { }
    return this;
  `,
        ),
    );
    await expect(world.callMethod("UnsupportedSql", Item.create("TestNode"))).rejects.toThrow(
        "T-SQL execution is not implemented",
    );
    expect(world.storage.listItems("TestNode")).toEqual([]);
    expect(
        world.trace
            .filter((entry) => entry.kind === "mutation")
            .every((entry) => entry.outcome === "rolledBack"),
    ).toBe(true);
}, 60_000);

test("C# event error Items roll back the action and retain failure evidence", async () => {
    const world = await create();
    load(
        world,
        method("RejectAfter", 'return this.getInnovator().newError("Original event rejection");') +
            event("onAfterUpdate", "RejectAfter"),
    );
    const reference = world.seed("TestNode", { name: "Before" });
    const edit = world.item(reference, "update");
    edit.setProperty("name", "After");
    const result = await world.apply(edit);
    expect(result.isError()).toBe(true);
    expect(result.getErrorString()).toBe("Original event rejection");
    expect(world.inspect(reference).properties.name).toBe("Before");
    expect(world.trace.find((entry) => entry.kind === "mutation")?.outcome).toBe("rolledBack");
}, 60_000);

test("managed state is isolated by world and reset while compiled artifacts are reusable", async () => {
    const code = `
    int count = (int)(AppDomain.CurrentDomain.GetData("harness-counter") ?? 0) + 1;
    AppDomain.CurrentDomain.SetData("harness-counter", count);
    this.setProperty("count", count.ToString()); return this;
  `;
    const first = await create();
    const second = await create();
    load(first, method("Counter", code));
    load(second, method("Counter", code));
    first.checkpoint();
    expect((await first.callMethod("Counter", Item.create("TestNode"))).getProperty("count")).toBe(
        "1",
    );
    expect((await first.callMethod("Counter", Item.create("TestNode"))).getProperty("count")).toBe(
        "2",
    );
    expect((await second.callMethod("Counter", Item.create("TestNode"))).getProperty("count")).toBe(
        "1",
    );
    first.reset();
    expect((await first.callMethod("Counter", Item.create("TestNode"))).getProperty("count")).toBe(
        "1",
    );
}, 60_000);

test("compilation diagnostics identify the original Method file", async () => {
    const world = await create();
    load(world, method("Invalid", "this.ApiThatDoesNotExist(); return this;"));
    await expect(world.callMethod("Invalid", Item.create("TestNode"))).rejects.toThrow(
        "managed-conformance.xml",
    );
}, 60_000);

test("source may declare helper types by closing and reopening its generated Method template", async () => {
    const world = await create();
    const code = `
    return new ContextHelper().Apply(this);
  }
  public sealed class ContextHelper {
    public Item Apply(Item item) {
      item.setProperty("name", "From the original helper type");
      return item;
    }
  }
  public void UnusedStartBrace() {
  `;
    load(world, method("HelperType", code));
    const result = await world.callMethod("HelperType", Item.create("TestNode"));
    expect(result.getProperty("name")).toBe("From the original helper type");
    expect(world.trace.find((event) => event.kind === "method")?.sourceHash).toBe(
        new Bun.CryptoHasher("sha256").update(code).digest("hex"),
    );
}, 60_000);

test("C# console output appears in Bun's terminal without corrupting Method results", async () => {
    const code = `
    Console.Write("C# stdout: ");
    Console.WriteLine("Hello from original source — æøå");
    Console.Error.WriteLine("C# stderr: diagnostic detail");
    Console.WriteLine("{\\"kind\\":\\"result\\",\\"id\\":\\"not-a-protocol-message\\"}");
    return this.getInnovator().newResult("Real Method result");
  `;
    const xml = `<AML>${method("WritesConsole", code)}</AML>`;
    const script = `
    import { createEngine } from ${JSON.stringify(sourcePath("../src/engine.ts"))};
    import { csharp } from ${JSON.stringify(sourcePath("../src/methods/csharp/executor.ts"))};
    import { Item } from ${JSON.stringify(sourcePath("../src/items/item.ts"))};
    import { parseAml } from ${JSON.stringify(sourcePath("../src/packages/parser.ts"))};
    import { importPackageDocuments } from ${JSON.stringify(sourcePath("../src/packages/module.ts"))};

    using world = createEngine({ executors: [csharp()] });
    world.runtime.executeSync(importPackageDocuments, [parseAml(${JSON.stringify(xml)}, "console-output.xml")]);
    const result = await world.callMethod("WritesConsole", Item.create("Method"));
    if (result.getResult() !== "Real Method result") throw new Error("Method result was corrupted.");
    console.log(result.getResult());
  `;
    const child = Bun.spawn([process.execPath, "--eval", script], {
        stdout: "pipe",
        stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("Real Method result");
    expect(stderr).toContain("C# stdout: Hello from original source — æøå");
    expect(stderr).toContain("C# stderr: diagnostic detail");
    expect(stderr).toContain('{"kind":"result","id":"not-a-protocol-message"}');
}, 60_000);

function sourcePath(path: string): string {
    return Bun.fileURLToPath(new URL(path, import.meta.url));
}
