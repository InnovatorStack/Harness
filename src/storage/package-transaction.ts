import type { HarnessStorage } from "./types.js";

export const packageTransaction = Symbol("packageTransaction");

interface PackageTransaction {
    [packageTransaction]<Result>(write: () => Result): Result;
}

function hasPackageTransaction(
    storage: HarnessStorage,
): storage is HarnessStorage & PackageTransaction {
    return packageTransaction in storage && typeof storage[packageTransaction] === "function";
}

/** An adapter can share one synchronous write boundary across a complete package import. */
export function withPackageTransaction<Result>(
    storage: HarnessStorage,
    write: () => Result,
): Result {
    if (hasPackageTransaction(storage)) {
        return storage[packageTransaction](write);
    }

    return write();
}
