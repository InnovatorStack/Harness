<picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/brand/mark-on-dark.svg">
    <img src="./assets/brand/mark.svg" width="96" height="96" alt="Harness">
</picture>

# Harness

Test Innovator solutions locally with Bun. Load normal AML package exports, add starting data, and run original server Methods against an isolated SQLite database.

[Documentation](https://innovatorstack.github.io/Harness/) · [Examples](./examples) · [Agent skill](./skills/innovator-harness/SKILL.md)

## Install

The preview is installed from a built archive. From this checkout:

```sh
bun install --frozen-lockfile
bun run build
bun pm pack
```

Copy the archive into your application, then run:

```sh
bun add --dev ./innovatorstack-harness-0.1.0.tgz
```

Use Bun 1.4.4. C# Methods also need the .NET 10 SDK.

## Write a test

Put your package exports in `.harness/packages/`. Define starting data in `.harness/fixtures.ts`; Harness loads it automatically. This example uses the model in [examples/basic](./examples/basic).

```ts
// .harness/fixtures.ts
import type { Fixtures } from "@innovatorstack/harness";

export default {
    ExampleDocument: [{ name: "Specification", remark: "Original" }],
} satisfies Fixtures;
```

Keep tests in your normal test directory:

```ts
// tests/solution.test.ts
import { expect, test } from "bun:test";

import { createHarness } from "@innovatorstack/harness";

test("changes a stored value", async () => {
    using world = await createHarness();
    const document = await world.getOne("ExampleDocument", { name: "Specification" });

    await world.update(document, { remark: "Reviewed" });

    const stored = await world.getOne("ExampleDocument", { name: "Specification" });
    expect(stored.properties.remark).toBe("Reviewed");
});
```

Run `bun test`. Each world starts with the configured data; `using` closes it after the test.

## Learn more

[Package loading](https://innovatorstack.github.io/Harness/setup/packages/) · [Mocks](https://innovatorstack.github.io/Harness/guides/mocking/) · [Inspection and controls](https://innovatorstack.github.io/Harness/guides/test-controls/) · [Compatibility](https://innovatorstack.github.io/Harness/reference/compatibility/)

This is a preview. General T-SQL and browser Method execution are not implemented; SQL boundaries can be mocked. See the compatibility guide for supported behavior and current limits.

[MIT license](./LICENSE).
