---
title: "Control a test"
---

## Read stored state

`world.state.get(type, selector?)` and `getOne(type, selector)` synchronously read immutable, detached stored records. They bypass get hooks and calculated response properties, and include historical generations. Use `is_current: 1` when inspecting the latest version. Reads require an idle world or a completed-request observer.

```ts
import { FailurePoint, ItemAction } from "@innovatorstack/harness";

const before = world.state.get("ExampleDocument");
const document = world.state.getOne("ExampleDocument", { name: "Specification" });

using observation = world.observe((execution) => {
    console.log(execution.outcome, execution.changes);
});

using failure = world.injectFailure({
    type: "ExampleDocument",
    action: ItemAction.Edit,
    when: { id: document.id },
    at: FailurePoint.AfterCall,
    error: new Error("Failure after saving"),
});

await expect(world.update(document, { remark: "Changed" })).rejects.toThrow();
expect(failure.triggered).toBe(true);
expect(world.state.get("ExampleDocument")).toEqual(before);
```

## Inject a failure

Failure targets also accept `{ method: "SubmitDocument", error }`, `{ sql: "ReadDocuments", error }`, or `{ sql: true, error }` for inline SQL. Optional `when` matches the same nested properties as mocks. `occurrence` selects the matching call entry (default 1). The default point is `BeforeCall`; `AfterCall` fires only when that selected invocation succeeds, before its caller continues or commits. An injected failure rolls back the owning transaction even if Method code catches it. Reports record fired rules in `failures`, with source locations and explicit omission counts. Disposal removes an unused rule without asserting that it fired.

## Observe completed requests

Observers run synchronously after commit or rollback, receiving the same immutable report as `executions`. A failing observer raises `ObserverError` after notifying the remaining subscribers; it cannot undo committed work. Business and observer failures are retained together. Observers may inspect raw state; operations and control changes cannot reenter the world during notification. Subscriptions survive `reset()` until disposed or the world closes.

## Control time and IDs

```ts
// .harness/config.ts — optional deterministic values; overrides also work per world.
import { fixedClock, seededIds } from "@innovatorstack/harness";
import type { HarnessConfig } from "@innovatorstack/harness";

export default {
    clock: fixedClock("2026-01-01T09:00:00Z"),
    ids: seededIds("document-tests"),
} satisfies HarnessConfig;
```

`world.clock.now()` returns a detached Date. `set(string | Date)` and `advance(milliseconds)` control Harness timestamps. ID generation covers fixtures, new items, generations and copied relationships; original package IDs stay intact. Fixture and business ID streams are separate. Each world owns fresh controls even when configuration objects are shared. `reset()` restores the post-setup clock, ID position and data, and clears failure rules and reports. Transaction rollback consumes issued IDs. Defaults use real time and random IDs; duration measurements and deadlines always use host time. C# `DateTime.Now` and `Guid.NewGuid()` remain native to the Method.
