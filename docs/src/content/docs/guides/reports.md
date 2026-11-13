---
title: "Inspect an execution"
---

Ordinary operations record completed requests automatically. Package imports and fixture setup stay outside this history.

```ts
await world.callMethod("SubmitDocument", parameters);

const run = world.executions.at(-1);
console.dir(run, { depth: null });

const compatibility = await checkCompatibility({
    executions: world.executions,
});
```

Each report contains `calls`, `changes`, `mocks`, `failures`, `outcome`, timings and an optional `error`. Calls form a parent/child tree with copied inputs/results, original source hashes, event bindings and typed `ExecutionKind`, `ExecutionMode` and `ExecutionStatus` values. Errors preserve the missing capability and originating call chain. Changes retain before/after records and a typed `ExecutionOutcome`, including attempted writes that rolled back.

## Source execution and mocks

`executed` means the source body began evaluation; inspect status and transaction outcome to see how it finished. The C# worker signals entry after compilation and loading. Compilation failures and mocks do not count as source execution. Compatibility observations match the effective source ID and hash; edited source invalidates older evidence. Observations retain failed and mocked calls separately and never establish native behavioral parity.

## Retention limits

Reports retain the latest 100 completed requests. Each request retains at most 2,000 calls and 5,000 semantic events, with bounded snapshots (64 KiB per snapshot, a 1 MiB capture budget and depth 32). `truncated` and `omitted` identify missing calls, changes, mocks, injected failures, events or snapshots. Cycles, accessors and unsupported values omit their snapshot without running getters. Existing `trace` remains available independently.

## Clear reports

`world.clearExecutions()` clears reports without changing stored data or `trace`. `reset()` also clears reports while restoring the configured starting state. Both require an idle world. Reports remain readable after `close()` and can be serialized with `Bun.write`.

Custom executors can call the optional `ports.executionStarted()` when source evaluation begins. Completing an executor call also records execution; adapters that can fail before evaluation should emit the signal at the actual entry point.
