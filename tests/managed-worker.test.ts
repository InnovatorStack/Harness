import { expect, spyOn, test } from "bun:test";

import { createHarness } from "../src/index.js";
import { referenceMethod, referenceProject } from "./helpers/references.js";

const counter = `
this.setProperty("count", (++Counter.Value).ToString());
return this;
}
private static class Counter
{
    internal static int Value;
}
private void Unused()
{`;

test("warm managed process reuse gives each world fresh Method statics", async () => {
    await using project = await referenceProject(referenceMethod("OwnedCounter", counter));
    const spawns = spyOn(Bun, "spawn");

    try {
        for (let index = 0; index < 3; index += 1) {
            {
                using h = await createHarness({ cwd: project.cwd, csharp: {} });
                expect((await h.callMethod("OwnedCounter")).getProperty("count")).toBe("1");
                expect((await h.callMethod("OwnedCounter")).getProperty("count")).toBe("2");
            }

            if (index === 0) {
                await Bun.sleep(150);
            }
        }

        const workers = spawns.mock.calls.filter(
            ([command]) =>
                Array.isArray(command) &&
                command.some(
                    (argument: unknown) =>
                        typeof argument === "string" &&
                        argument.endsWith("InnovatorHarness.Managed.dll"),
                ),
        );
        expect(workers).toHaveLength(1);
    } finally {
        spawns.mockRestore();
    }
}, 60_000);

test("process-wide AppDomain values do not leak after a world closes", async () => {
    const code = `var previous = AppDomain.CurrentDomain.GetData("owned-global");
        AppDomain.CurrentDomain.SetData("owned-global", "Changed");
        return this.getInnovator().newResult(previous == null ? "Clean" : "Leaked");`;
    await using project = await referenceProject(referenceMethod("GlobalState", code));

    for (let index = 0; index < 2; index += 1) {
        using h = await createHarness({ cwd: project.cwd, csharp: {} });
        expect((await h.callMethod("GlobalState")).getResult()).toBe("Clean");
    }
}, 60_000);

test("JSON serializer global settings cannot leak into another world", async () => {
    const change = `Newtonsoft.Json.JsonConvert.DefaultSettings = () =>
        new Newtonsoft.Json.JsonSerializerSettings { Formatting = Newtonsoft.Json.Formatting.Indented };
        return this;`;
    const read = `return this.getInnovator().newResult(
        Newtonsoft.Json.JsonConvert.DefaultSettings == null ? "Clean" : "Leaked");`;
    await using project = await referenceProject(
        referenceMethod("ChangeGlobals", change) + referenceMethod("ReadGlobals", read),
    );

    {
        using first = await createHarness({ cwd: project.cwd, csharp: {} });
        await first.callMethod("ChangeGlobals");
        expect((await first.callMethod("ReadGlobals")).getResult()).toBe("Leaked");
    }

    using second = await createHarness({ cwd: project.cwd, csharp: {} });
    expect((await second.callMethod("ReadGlobals")).getResult()).toBe("Clean");
}, 60_000);

test("readonly static collections remain isolated when compiled code is retained", async () => {
    const code = `Values.Add("entry");
        return this.getInnovator().newResult(Values.Count.ToString());
        }
        private static readonly System.Collections.Generic.List<string> Values = new();
        private void Unused() {`;
    await using project = await referenceProject(referenceMethod("StaticCollection", code));

    for (let index = 0; index < 3; index += 1) {
        using h = await createHarness({ cwd: project.cwd, csharp: {} });
        expect((await h.callMethod("StaticCollection")).getResult()).toBe("1");
        expect((await h.callMethod("StaticCollection")).getResult()).toBe("2");
    }
}, 60_000);

test("bounded worker reuse retires a process after 32 worlds", async () => {
    await using project = await referenceProject(
        referenceMethod("Stateless", "return this;") +
            referenceMethod("Dedicated", 'AppDomain.CurrentDomain.GetData("unused"); return this;'),
    );

    {
        using dedicated = await createHarness({ cwd: project.cwd, csharp: {} });
        await dedicated.callMethod("Dedicated");
    }

    const spawns = spyOn(Bun, "spawn");

    try {
        for (let index = 0; index < 33; index += 1) {
            using h = await createHarness({ cwd: project.cwd, csharp: {} });
            expect((await h.callMethod("Stateless")).isError()).toBe(false);
        }

        const workers = spawns.mock.calls.filter(
            ([command]) =>
                Array.isArray(command) &&
                command.some(
                    (argument: unknown) =>
                        typeof argument === "string" &&
                        argument.endsWith("InnovatorHarness.Managed.dll"),
                ),
        );
        expect(workers).toHaveLength(2);
    } finally {
        spawns.mockRestore();
    }
}, 60_000);

test("a Bun script exits after disposing its last managed world", async () => {
    await using project = await referenceProject(referenceMethod("ExitCleanly", "return this;"));
    const entry = Bun.fileURLToPath(new URL("../src/index.ts", import.meta.url));
    const script = `import { createHarness } from ${JSON.stringify(entry)};
        { using h = await createHarness({ cwd: ${JSON.stringify(project.cwd)}, csharp: {} });
          await h.callMethod("ExitCleanly"); }
        console.log("Disposed");`;
    const process = Bun.spawn([Bun.which("bun") ?? "bun", "-e", script], {
        cwd: project.cwd,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 15_000,
    });
    const [exit, stdout, stderr] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(stdout.trim()).toBe("Disposed");
    expect(exit).toBe(0);
}, 60_000);
