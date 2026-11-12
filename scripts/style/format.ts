import { formatManagedSource } from "./managed.js";
import { formatTypeScriptLayout } from "./typescript.js";

const directory = Bun.fileURLToPath(new URL("../..", import.meta.url));
const write = process.argv.includes("--write");
const mode = write ? "--write" : "--check";
const formatter = Bun.spawn([process.execPath, "--bun", "run", "oxfmt", mode, "."], {
    cwd: directory,
    stdout: "inherit",
    stderr: "inherit",
});
const managedExit = await formatManagedSource(directory, write);
const formatterExit = await formatter.exited;

if (write && formatterExit === 0) {
    await formatTypeScriptLayout(directory);
    const layoutFormat = Bun.spawn([process.execPath, "--bun", "run", "oxfmt", "--write", "."], {
        cwd: directory,
        stdout: "inherit",
        stderr: "inherit",
    });

    if ((await layoutFormat.exited) !== 0) {
        process.exitCode = 1;
    }
}

if (managedExit !== 0 || formatterExit !== 0) {
    process.exitCode = 1;
}
