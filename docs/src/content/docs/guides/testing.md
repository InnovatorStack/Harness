---
title: "Actions and Methods"
---

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

## Isolation and reset

Run with `bun test`. Each live world owns its in-memory SQLite connection and executor state. `using` closes the world. `reset()` rolls back to the configured starting data and clears execution traces.

## Setup reuse

Unchanged package and fixture setup is reused. Each world still gets isolated data, controls, mocks and reports. Editing an input invalidates the cached setup. `reset()` restores the starting data without rebuilding the world.

Tests use in-memory databases. Harness retains at most four setup snapshots and four idle databases, each with a combined 64 MiB budget. One replaceable `.harness/cache/setup.bin` file, also limited to 64 MiB, speeds up subsequent test runs. There is no database file per test. Larger setups work without snapshot retention.

## Per-test overrides

Use a per-world fixture list to replace the shared starting data:

```ts
using world = await createHarness({
    fixtures: ["./fixtures/submission.ts"],
});
```

## Choose the operation

`get` returns record snapshots, `getOne` requires exactly one result, and `add`, `update`, and `delete` run platform actions. Update sends the supplied changes. Package event code determines any additional mutations. Normal get calls run imported get events.

`callMethod(name, properties)` invokes original Method source. Nested property objects become native Item parameters; explicit Items from `@innovatorstack/harness/items` also work. Method calls and `applyAML` return Item results, including business error Items; high-level record operations throw on an error result. Framework capability failures always reject and invalidate the owning transaction.

`world.trace` records actions, imported event bindings, Method source hashes, mutations, and transaction outcomes. A completed nested call does not imply its changes committed.
