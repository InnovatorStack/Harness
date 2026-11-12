import { availableParallelism } from "node:os";

const workerLimit = 4;
const coresPerWorker = 2;
const availableCores = availableParallelism();
const workers = Math.min(workerLimit, Math.max(1, Math.floor(availableCores / coresPerWorker)));

// Each Bun worker also starts managed compilation and execution processes.
console.log(`Test workers: ${workers}; available CPUs: ${availableCores}.`);
const command = Bun.spawn(
    [process.execPath, "test", `--parallel=${workers}`, ...Bun.argv.slice(2)],
    {
        cwd: Bun.fileURLToPath(new URL("..", import.meta.url)),
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
    },
);

process.exitCode = await command.exited;
