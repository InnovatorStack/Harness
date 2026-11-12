import { expect, test } from "bun:test";
import { join } from "node:path";

import { loadSetupModule } from "../src/harness/setup-module.js";
import { object } from "../src/items/codec.js";
import { controlProject } from "./helpers/controls.js";

test("temporary setup bundles preserve package singleton identity for static and dynamic imports", async () => {
    await using project = await controlProject();
    const packagePath = join(project.cwd, "node_modules/setup-controls");
    await Bun.write(
        join(packagePath, "package.json"),
        JSON.stringify({
            name: "setup-controls",
            type: "module",
            exports: "./index.js",
        }),
    );
    const modulePath = join(packagePath, "index.js");
    await Bun.write(modulePath, 'export const identity = Symbol("package identity");');
    const original: unknown = await import(modulePath);
    const setup = join(project.cwd, ".harness/imports.ts");
    await Bun.write(
        setup,
        `
import { identity } from "setup-controls";
import { basename } from "node:path";
export { identity as reexported } from "setup-controls";
const dynamic = await import("setup-controls");
export default {
    identity,
    dynamic: dynamic.identity,
    filename: basename(import.meta.path),
    literal: "import 'this-is-not-a-package'",
};`,
    );

    const loaded = await loadSetupModule(setup);

    if (!object(original) || !object(loaded) || !object(loaded.default)) {
        throw new TypeError("The test packages must export module objects.");
    }

    expect(loaded.default.identity).toBe(original.identity);
    expect(loaded.default.dynamic).toBe(original.identity);
    expect(loaded.reexported).toBe(original.identity);
    expect(loaded.default.filename).toBe("imports.ts");
    expect(loaded.default.literal).toBe("import 'this-is-not-a-package'");
});
