import { inspectPackages } from "./inspection.js";
import type { PackageVerificationOptions, PackageVerificationReport } from "./types.js";

/** Inspect configured package XML without loading fixtures or executing Methods. */
export async function verifyPackages(
    options: PackageVerificationOptions = {},
): Promise<PackageVerificationReport> {
    using inspection = await inspectPackages(options);

    return inspection.report;
}
