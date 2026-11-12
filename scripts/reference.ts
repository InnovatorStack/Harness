import { join, resolve } from "node:path";

import { nativeEventBindings } from "../tests/reference/metadata.js";
import { runReferenceSuite } from "../tests/reference/suite.js";
import type { SuiteOptions } from "../tests/reference/suite.js";
import { ComparisonStatus } from "../tests/reference/types.js";

const options = argumentsFor(process.argv.slice(2));
const report = await runReferenceSuite(options);
const directory = Bun.fileURLToPath(new URL("../tests/results/reference", import.meta.url));

await Bun.write(join(directory, "report.json"), JSON.stringify(report, null, 2));
await Bun.write(
    join(directory, "inputs.json"),
    JSON.stringify(
        {
            ...report.inputs,
            eventBindings: Object.fromEntries(nativeEventBindings(report.inputs.files)),
        },
        null,
        2,
    ),
);

for (const result of report.results) {
    const contract = result.contractPassed ? "PASS" : "FAIL";
    console.log(`${contract} ${result.caseId}: ${result.comparison}`);

    for (const message of [result.contractError, result.diagnostic]) {
        if (message) {
            console.error(`    ${message}`);
        }
    }
}

const matched = report.results.filter(
    (result) => result.comparison === ComparisonStatus.Matched,
).length;
console.log(
    `\nNative comparisons: ${matched}/${report.results.length}. Report: ${join(directory, "report.json")}`,
);
process.exitCode = report.passed ? 0 : 1;

function argumentsFor(arguments_: readonly string[]): SuiteOptions {
    let nativeDirectory: string | undefined;
    let requireNative = false;

    for (let index = 0; index < arguments_.length; index += 1) {
        const argument = arguments_[index];

        const directory = arguments_[index + 1];

        if (
            argument === "--native" &&
            directory &&
            !directory.startsWith("--") &&
            !nativeDirectory
        ) {
            nativeDirectory = resolve(directory);
            index += 1;
        } else if (argument === "--require-native") {
            requireNative = true;
        } else {
            throw new Error(
                "Usage: bun run scripts/reference.ts [--native directory] [--require-native]",
            );
        }
    }

    return { requireNative, ...(nativeDirectory ? { nativeDirectory } : {}) };
}
