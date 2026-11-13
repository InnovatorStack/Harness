---
title: "Getting started"
---

Harness runs your Innovator solution locally so a test can invoke its real Methods, fetch stored records, and check the result. Packages supply the schema and event wiring. Fixtures supply starting data.

## 1. Install the preview

Build the package from a checkout:

```sh
bun install --frozen-lockfile
bun run build
bun pm pack
```

Copy the generated archive into your application and install it:

```sh
bun add --dev ./innovatorstack-harness-0.1.0.tgz
```

Use Bun 1.4.4. Running C# Methods also requires the .NET 10 SDK. The SDK is not needed for a test that only uses TypeScript and AML.

## 2. Add your package exports

Place normal XML exports under `.harness/packages/`. You can keep their exported folder structure. Harness loads the XML recursively; you do not need a preparation script or a manifest.

```text
.harness/
  packages/
    your-solution/
  fixtures.ts
tests/
  solution.test.ts
```

Supply the packages your solution depends on as well. [Package loading](/Harness/setup/packages/) explains extra paths, import order and missing references.

## 3. Define starting data

Fixture property names come from your imported schema. The following model is supplied by the repository's [basic example](https://github.com/InnovatorStack/Harness/tree/main/examples/basic).

```ts
// .harness/fixtures.ts
import type { Fixtures } from "@innovatorstack/harness";

export default {
    ExampleDocument: [{ name: "Specification", remark: "Original" }],
} satisfies Fixtures;
```

These records are already in the database when `createHarness()` returns. Tests query them normally. [Fixtures](/Harness/setup/fixtures/) also support reference selectors and AML data exports.

## 4. Write a normal Bun test

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

Run it from your application:

```sh
bun test
```

`using` closes the world. Other tests get their own data. Use `world.callMethod()` for server Methods or `world.applyAML()` for native AML actions. [Actions and Methods](/Harness/guides/testing/) covers both.

## Next

- [Mock a dependency](/Harness/guides/mocking/) to replace a SQL call or another boundary while the rest executes normally.
- [Inspect an execution](/Harness/guides/reports/) to see calls, state changes, mocks and rollback.
- [Check compatibility](/Harness/reference/compatibility/) before relying on a platform feature.
