import { expect, test } from "bun:test";
import { join } from "node:path";

import { readSetupImage, writeSetupImage } from "../src/harness/setup-image.js";
import { createHarness } from "../src/index.js";
import { referenceProject } from "./helpers/references.js";

test("setup artifacts replace one file and reject changed keys, control state and database bytes", async () => {
    await using project = await referenceProject();
    const path = join(project.cwd, ".harness/cache/image.bin");
    const image = {
        database: new Uint8Array([1, 2, 3]),
        values: { clock: 123, ids: { fixtures: 2, items: 0 } },
    };
    await writeSetupImage(path, "first", image);
    const ignore = join(project.cwd, ".harness/cache/.gitignore");
    expect(await Bun.file(ignore).text()).toBe("*\n");
    await Bun.write(ignore, "Existing ignore rules\n");
    expect(await readSetupImage(path, "first")).toEqual(image);
    expect(await readSetupImage(path, "second")).toBeUndefined();
    await writeSetupImage(path, "second", image);
    expect(await Bun.file(ignore).text()).toBe("Existing ignore rules\n");
    expect(await readSetupImage(path, "first")).toBeUndefined();

    const original = await Bun.file(path).bytes();
    const changed = Uint8Array.from(original);
    const last = changed.at(-1);

    if (last === undefined) {
        throw new Error("The encoded image must contain database bytes.");
    }

    changed[changed.length - 1] = last ^ 1;
    await Bun.write(path, changed);
    expect(await readSetupImage(path, "second")).toBeUndefined();
    await Bun.write(path, new TextDecoder().decode(original).replace('"clock":123', '"clock":124'));
    expect(await readSetupImage(path, "second")).toBeUndefined();
});

test("a fresh Bun process copies a saved setup without rerunning the importer", async () => {
    await using project = await referenceProject();

    {
        using first = await createHarness({ cwd: project.cwd });
        await first.add("ReferenceRecord", { name: "Private change" });
    }

    const runtime = Bun.fileURLToPath(new URL("../src/index.ts", import.meta.url));
    const importer = Bun.fileURLToPath(new URL("../src/packages/importer.ts", import.meta.url));
    const script = `import { createHarness } from ${JSON.stringify(runtime)};
        import { PackageImporter } from ${JSON.stringify(importer)};
        PackageImporter.prototype.import = () => { throw new Error("Unexpected setup re-import"); };
        using h = await createHarness({ cwd: ${JSON.stringify(project.cwd)} });
        if (h.state.get("ReferenceRecord", { name: "Parent" }).length !== 1) throw new Error("Missing seed");
        if (h.state.get("ReferenceRecord", { name: "Private change" }).length !== 0) throw new Error("Leaked write");`;
    const child = Bun.spawn([process.execPath, "--eval", script], {
        stdout: "pipe",
        stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
    ]);

    expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: "", stderr: "" });
}, 30_000);
