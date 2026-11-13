---
title: "API"
---

## Default entry point

Import consumer APIs from `@innovatorstack/harness`.

| API                                  | Result                                                              |
| ------------------------------------ | ------------------------------------------------------------------- |
| `await createHarness(options?)`      | An isolated world after packages and fixtures load.                 |
| `await verifyPackages(options?)`     | Import diagnostics and Method/SQL inventory; no business execution. |
| `await checkCompatibility(options?)` | Known capabilities, executors, mocks and source gaps.               |

## World operations

| Call                            | Behavior                                                                                  |
| ------------------------------- | ----------------------------------------------------------------------------------------- |
| `get(type, selector?)`          | Queries through imported Get hooks; returns record snapshots.                             |
| `getOne(type, selector)`        | Requires one result.                                                                      |
| `add(type, properties)`         | Runs creation and its hooks.                                                              |
| `update(record, changes)`       | Runs the edit action, including version behavior.                                         |
| `delete(record)`                | Runs deletion and owned/dependent cleanup.                                                |
| `callMethod(name, parameters?)` | Executes the imported Method or an explicit matching mock.                                |
| `applyAML(xml)`                 | Runs a native AML request.                                                                |
| `reset()`                       | Restores starting data and controlled values; clears execution history and failure rules. |
| `close()`                       | Releases the world; prefer `using`.                                                       |

Method calls and `applyAML` return native Item results, including business error Items. High-level record operations throw on an error result. Missing platform capabilities reject the owning transaction.

## Instrumentation

| API                         | Use                                                                |
| --------------------------- | ------------------------------------------------------------------ |
| `state.get`, `state.getOne` | Read raw stored records without hooks.                             |
| `executions`                | Completed request reports with calls, changes, mocks and outcomes. |
| `trace`                     | Platform action and event trace.                                   |
| `observe(callback)`         | Subscribe to completed requests.                                   |
| `injectFailure(rule)`       | Fail a matching call before or after execution.                    |
| `clock`                     | Inspect, set or advance controlled time.                           |
| `clearExecutions()`         | Clear reports without changing data.                               |

See [test controls](/Harness/guides/test-controls/) for imports and complete examples.

## Extension entry points

Low-level APIs have separate entry points:

- `@innovatorstack/harness/engine`: explicit engine construction and instrumentation.
- `@innovatorstack/harness/core`: operations, module contracts, scoped execution.
- `@innovatorstack/harness/packages`: AML parsing/import contracts.
- `@innovatorstack/harness/storage/sqlite`: Bun SQLite storage and storage types.
- `@innovatorstack/harness/items`: native Item representation for application bridges.
- `@innovatorstack/harness/methods` and `/csharp`: executor contracts and managed execution.
