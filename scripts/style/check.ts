import { checkManagedStyle } from "./managed.js";
import { checkTypeScriptStyle } from "./typescript.js";

const directory = Bun.fileURLToPath(new URL("../..", import.meta.url));
const lint = Bun.spawn([process.execPath, "--bun", "run", "oxlint", "--deny-warnings", "."], {
    cwd: directory,
    stdout: "inherit",
    stderr: "inherit",
});

const diagnostics = await checkTypeScriptStyle(directory);

for (const diagnostic of diagnostics) {
    console.error(
        `${diagnostic.file}:${diagnostic.line}: ${diagnostic.rule}: ${diagnostic.message}`,
    );
}

const managedExit = await checkManagedStyle(directory);
const lintExit = await lint.exited;

if (diagnostics.length > 0 || managedExit !== 0 || lintExit !== 0) {
    process.exitCode = 1;
}
