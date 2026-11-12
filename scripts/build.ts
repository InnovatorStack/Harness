import { rm } from "node:fs/promises";
import { join } from "node:path";

import { prepareBuiltinDatabase } from "../src/baseline/database.js";

const directory = Bun.fileURLToPath(new URL("../dist", import.meta.url));
await rm(directory, { recursive: true, force: true });

const compiler = Bun.spawn(["bun", "--bun", "run", "tsc", "-p", "tsconfig.build.json"], {
    cwd: Bun.fileURLToPath(new URL("..", import.meta.url)),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
});

process.exitCode = await compiler.exited;

if (process.exitCode === 0) {
    await Bun.write(
        new URL("../dist/baseline/database.bin", import.meta.url),
        prepareBuiltinDatabase(),
    );
    const source = Bun.fileURLToPath(new URL("../src/methods/csharp/managed", import.meta.url));
    const destination = join(directory, "methods/csharp/managed");

    for (const file of new Bun.Glob("*.{cs,csproj,Config,template}").scanSync({ cwd: source })) {
        await Bun.write(join(destination, file), Bun.file(join(source, file)));
    }
}
