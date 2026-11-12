---
name: innovator-harness
description: Set up and debug source-backed Aras solution tests with InnovatorHarness, using Bun, AML exports, automatic fixtures, selective mocks and stored-state assertions.
---

Use the installed `@innovatorstack/harness` public exports. Read the project's existing
`.harness` setup and the relevant original Method/event source before changing a test.
Consult the installed package's README and declarations for options beyond these examples.

Write readable tests: 4 spaces, a 100-column measure, braces and blank lines between phases.
Keep functions within 70 physical lines. Avoid non-null assertions, unchecked casts and
recursive report walkers; use explicit guards and bounded iteration when inspecting a tree.
Keep assertions local to the behavior being tested. Add execution-report helpers when their
evidence is needed, rather than turning every business test into a framework audit.

## Set up the solution

- Run with Bun. C# execution additionally needs the .NET 10 SDK; TypeScript and AML tests
  do not require it. Harness is a local library, with no Aras server to start.
- Put normal exports under `.harness/packages/`. XML is discovered recursively;
  `imports.mf` is not followed automatically. Configured extra package paths are relative
  to `.harness/config.ts`. Use the project's existing export layout.
- Packages own schema, Methods, events, lifecycles and their ordering. Supply missing
  dependency exports or report the unresolved references. Do not invent prerequisites,
  patch original Methods, or remove package content to get a passing test.
- Shared starting data goes in `.harness/fixtures.ts` or `.harness/fixtures/` and loads
  automatically. Use imported property names and meaningful reference selectors. Fixtures
  bypass business hooks; call a normal action when creation behavior is under test.
- Keep tests and project helpers outside `.harness`. Configuration is optional. Preserve
  existing session and authorization settings; use exported enums for declared modes.

```ts
// .harness/fixtures.ts — ExampleReview must exist in the supplied export.
import type { Fixtures } from "@innovatorstack/harness";

export default {
    ExampleReview: [{ name: "Incomplete", missing_info: "Required attachment", remark: "Before" }],
} satisfies Fixtures;
```

## Exercise the real path

Call the application's entry Method or action, then query the database again. A successful
return or compilation alone does not establish the business result. For versionable items,
read the current record through its stable business key or `config_id` and `is_current`;
an old ID can still identify the previous generation. Inspect the imported version policy.

```ts
// tests/submission.test.ts — adapt Method and property names to the original source.
import { expect, test } from "bun:test";

import { createHarness } from "@innovatorstack/harness";

test("saves permitted changes without setting an incomplete review's date", async () => {
    using harness = await createHarness();
    const before = await harness.getOne("ExampleReview", { name: "Incomplete" });

    const response = await harness.callMethod("SubmitReview", {
        review_id: before.id,
        remark: "After",
        approved_on: "2026-02-01T00:00:00",
    });

    expect(response.isError()).toBe(false);
    const after = await harness.getOne("ExampleReview", { name: "Incomplete" });
    expect(after.properties.remark).toBe("After");
    expect(after.properties.approved_on).toBe(before.properties.approved_on);
});
```

For a rule, cover its permitted and rejected branches. For transactional behavior, inspect
stored changes and related records after a failure. `harness.state` bypasses get hooks for raw
inspection; normal `get`/`getOne` runs them. `harness.executions` and `harness.trace` distinguish
source execution, replaced calls, mutations and transaction outcomes.

`using` disposes each world. `reset()` restores setup data, controlled clock/ID positions and
reports. Do not share a live world across concurrent tests or clone database files per test.

## Replace only the selected boundary

Shared mocks live in `.harness/mocks.json`; response files live beside them. A per-test
`createHarness({ mocks: [...] })` override replaces matching calls while retaining other
shared mocks. An explicit empty list disables shared mocks.

- `{ method: "ReadReviewRules", response: { json: { allow_review: true } } }` replaces that
  Method without executing its body. Everything unmatched runs normally.
- `{ sql: "SearchCatalog", response: "./responses/catalog.xml" }` replaces a named SQL call.
- `{ sql: true, when: { method: "LoadCatalog" }, response: "./responses/catalog.xml" }`
  replaces inline SQL called from that Method. Narrow matching using actual call parameters.

Captured responses are mocks, not stored fixture records. Seed records separately when the
real Methods query or update them. Do not mock the entry Method or validation hook whose
behavior the test is intended to establish. SQL and JavaScript execution are not provided;
unmatched unsupported calls must remain visible rather than silently succeeding.

## Diagnose and verify

Use `verifyPackages()` for import diagnostics and source inventories. Use
`checkCompatibility()` for detected capability gaps; optional `{ compile: true }` compiles
unmocked C# without executing business Methods. Neither report proves every runtime branch
works or establishes parity with a native release.

Run the affected `bun test` commands and the project's existing type, lint and format checks.
Report checks that the environment cannot run. Prefer plain field comparisons and
`toMatchObject` when typed collections reject Bun asymmetric matchers that expose `any`.
Inspect stored outcomes, source execution and mock provenance. Keep customer packages,
captures, credentials, connection details and test data
out of published artifacts. Live connections require their own authorization; local testing
does not authorize changing a server or invoking a remote custom Method.
