<picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/brand/mark-on-dark.svg">
    <img src="./assets/brand/mark.svg" width="96" height="96" alt="Harness">
</picture>

# Harness

A Bun and TypeScript library for testing applications against a local, instrumentable Innovator environment. Packages define the model and business logic. Fixtures supply starting data. Tests use an isolated SQLite database.

Bun is the runtime and test runner; C# Methods additionally require the .NET 10 SDK.
For this preview, build the package from a checkout:

```sh
bun install --frozen-lockfile
bun run build
bun pm pack
```

Copy the resulting archive into your application and run
`bun add --dev ./innovatorstack-harness-0.1.0.tgz`.

```text
.harness/
  config.ts
  packages/
    solution/Import/
  fixtures/
    records.ts

tests/
  solution.test.ts
```

`createHarness()` loads the setup before returning. Ordinary tests do not import package definitions, seed records, parse XML, or manage the database baseline.

Run the [basic example](./examples/basic) for fixture loading, updates and reset. The
[server Methods example](./examples/server-methods) runs an original C# submit Method and
its imported validation hook, with one explicitly mocked dependency and stored-state assertions.
Each example's README shows how to install the built archive and run its tests.

The [agent skill](./skills/innovator-harness/SKILL.md) covers setup, source-backed tests,
selective mocks and diagnostics. Copy its `innovator-harness` folder into your agent's
skill directory; it needs no server connection or extra tools.

## Configuration

Paths resolve relative to the configuration file.

```ts
// .harness/config.ts
import type { HarnessConfig } from "@innovatorstack/harness";

export default {
    packages: ["../../shared-packages"],
} satisfies HarnessConfig;
```

The configuration is optional. By convention, Harness finds the nearest `.harness` directory, loads package inputs under `packages`, and reads `fixtures.ts` and the `fixtures` directory when present. Tests stay outside `.harness`.

Harness always loads XML recursively from `.harness/packages`, plus any configured extra paths. Extra paths resolve relative to the configuration file. Folder discovery does not follow `imports.mf`. An explicitly supplied manifest uses its declared paths and dependency order. Actions inside each XML file retain their original order; dependencies across files resolve through the importer.

An explicit `packages` list retains caller order. Overlapping inputs, dependency cycles and conflicting additions fail setup. Projects supply their dependencies; Harness does not search other repositories or download solution packages. A package delete removes matching records and succeeds when none remain, allowing exported cleanup of platform-generated forms and views.

Native platform ItemTypes replace the built-in metadata stand-ins with their exported IDs. Original XML, source locations and hashes remain available through the engine catalog. Presentation definitions are retained as metadata; executing them requires an adapter. This baseline is not a claim of full compatibility with a particular Innovator release.

## Package verification

```ts
import { verifyPackages, PackageIssueCode } from "@innovatorstack/harness";

const report = await verifyPackages();
const missing = report.issues.filter((issue) => issue.code === PackageIssueCode.MissingDependency);
```

Verification uses the same configuration and package discovery as normal setup. It checks imports against the built-in baseline in a disposable in-memory database. Issues contain typed codes, source locations, conflicting sources and unresolved reference details where available. Readable files are still inventoried when another input fails.

`canImport` describes metadata import into Harness. `methods` and `sql` list supplied source declarations, including patches, with their hashes and locations. Verification does not compile or execute those bodies. Fixtures, mock response files and executor factories are outside this check; ordinary world setup still loads them.

## Compatibility checks

```ts
import { checkCompatibility, CompatibilityIssueCode } from "@innovatorstack/harness";

const report = await checkCompatibility();
const missingExecutors = report.issues.filter(
    (issue) => issue.code === CompatibilityIssueCode.ExecutorUnavailable,
);

// Optional: compile effective C# source without invoking it.
const compiled = await checkCompatibility({ compile: true });
```

`packages` is the metadata verification report. `capabilities` describes implemented platform features, limitations and framework test evidence. `methods` and `sql` account for every supplied declaration, with effective imported definitions, executor status and matching mock rules. Capability IDs, statuses and issue codes are exported enums.

The check reads the existing configuration and mock responses, including per-test overrides. An unconditional mock skips source compilation and dependency probes. Conditional mocks leave the original executor requirement visible. Only unmocked C# needs SDK and assembly checks; compilation uses the existing managed adapter and its cache.

Fixtures and extension factories do not execute during preflight. Custom executor support is unknown until runtime. Source patches are checked against the effective body and hash; an overwritten declaration is retained in the inventory. Typed issues locate unsupported event versions, ambiguous event order, lifecycle post-commit Methods, workflow startup, storage adapters and authorization boundaries. Metadata warnings describe requirements if those paths are reached.

Compilation, execution and native reference verification remain separate facts. The check never invokes business Methods or SQL. Without supplied execution reports, `executed` remains false. `referenceVerified` remains false until a native comparison exists. Dynamic calls and unexercised branches remain unknown. Mapped runtime `PlatformError`s carry the same `capability` ID as preflight diagnostics.

## Fixtures

A TypeScript fixture file groups starting records by imported ItemType. These names and
properties must exist in the supplied package. This uses the model from the basic example.

```ts
// .harness/fixtures.ts
import type { Fixtures } from "@innovatorstack/harness";

export default {
    ExampleDocument: [{ name: "Specification", remark: "Original" }],
} satisfies Fixtures;
```

Harness derives each reference's target ItemType from package metadata and generates record IDs. Reference selectors must identify exactly one final record. Forward references and cycles across fixture files work. Put imported helper data outside the automatically discovered fixture directory; each TypeScript file inside it must default-export fixture records.

AML data exports are also supported alongside TypeScript data modules. An AML fixture with an existing ID overlays that starting record; omitted fields remain intact. Definition changes belong in packages. Calculated foreign and federated values remain in the original input document; they are not persisted as writable columns. A current generation can retain its historical `config_id` without requiring the first generation's row.

Fixture loading bypasses business action hooks. Normal application operations run those hooks. Missing properties, invalid values, ambiguous references, or missing dependencies fail setup and release the world.

For declarative fixtures, lifecycle defaults come from the imported map. Set `state` to a named state to derive its `current_state`; supplying both requires them to agree. Tests do not need to copy state IDs.

## Normal Bun tests

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

Run with `bun test`. Each live world owns its in-memory SQLite connection and executor state. `using` closes the world. `reset()` rolls back to the configured starting data and clears execution traces.

Each new world rereads packages, fixtures and responses, including local modules and JSON imported by setup modules. Unchanged setup loads from a snapshot captured before test code can write to it. Sequential worlds can reuse a clean connection after its previous world closes; concurrent worlds use separate connections. Controls, mocks, reports and storage wrappers are fresh for every world. Changes to setup contents or Harness invalidate the snapshot. Custom modules and authorization callbacks still run through fresh setup.

Harness retains at most four setup snapshots with a combined 64 MiB database budget in memory. One replaceable `.harness/cache/setup.bin` artifact, limited to 64 MiB, avoids reimporting unchanged setup in another Bun run. Tests do not create database files. Larger setups work without snapshot retention. Setup modules compile with Bun into temporary files removed after import; their original `import.meta` locations and consumer package resolution are preserved.

The idle connection pool retains at most four databases whose setup images total 64 MiB. Closing a world rolls back its writes before returning its connection to that pool. Reset uses a SQLite savepoint without copying the database; explicit snapshots retain their existing copy semantics. File-backed engines continue to commit durable writes.

Local overrides replace shared package/fixture lists:

```ts
using world = await createHarness({
    fixtures: ["./fixtures/submission.ts"],
});
```

`get` returns record snapshots, `getOne` requires exactly one result, and `add`, `update`, and `delete` run platform actions. Update sends the supplied changes. Package event code determines any additional mutations. Normal get calls run imported get events.

`callMethod(name, properties)` invokes original Method source. Nested property objects become native Item parameters; explicit Items from `@innovatorstack/harness/items` also work. Method calls and `applyAML` return Item results, including business error Items; high-level record operations throw on an error result. Framework capability failures always reject and invalidate the owning transaction.

`world.trace` records actions, imported event bindings, Method source hashes, mutations, and transaction outcomes. A completed nested call does not imply its changes committed.

## Execution reports

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

`executed` means the source body began evaluation; inspect status and transaction outcome to see how it finished. The C# worker signals entry after compilation and loading. Compilation failures and mocks do not count as source execution. Compatibility observations match the effective source ID and hash; edited source invalidates older evidence. Observations retain failed and mocked calls separately and never establish native behavioral parity.

Reports retain the latest 100 completed requests. Each request retains at most 2,000 calls and 5,000 semantic events, with bounded snapshots (64 KiB per snapshot, a 1 MiB capture budget and depth 32). `truncated` and `omitted` identify missing calls, changes, mocks, injected failures, events or snapshots. Cycles, accessors and unsupported values omit their snapshot without running getters. Existing `trace` remains available independently.

`world.clearExecutions()` clears reports without changing stored data or `trace`. `reset()` also clears reports while restoring the configured starting state. Both require an idle world. Reports remain readable after `close()` and can be serialized with `Bun.write`.

Custom executors can call the optional `ports.executionStarted()` when source evaluation begins. Completing an executor call also records execution; adapters that can fail before evaluation should emit the signal at the actual entry point.

## Test controls

`world.state.get(type, selector?)` and `getOne(type, selector)` synchronously read immutable, detached stored records. They bypass get hooks and calculated response properties, and include historical generations. Use `is_current: 1` when inspecting the latest version. Reads require an idle world or a completed-request observer.

```ts
const before = world.state.get("Document");
const document = world.state.getOne("Document", { item_number: "DOC-001", is_current: 1 });

using observation = world.observe((execution) => {
    console.log(execution.outcome, execution.changes);
});

using failure = world.injectFailure({
    type: "Document",
    action: ItemAction.Edit,
    when: { id: document.id },
    at: FailurePoint.AfterCall,
    error: new Error("Failure after saving"),
});

await expect(world.update(document, { description: "Changed" })).rejects.toThrow();
expect(failure.triggered).toBe(true);
expect(world.state.get("Document")).toEqual(before);
```

Import `ItemAction` and `FailurePoint` from `@innovatorstack/harness`. Failure targets also accept `{ method: "SubmitDocument", error }`, `{ sql: "ReadDocuments", error }`, or `{ sql: true, error }` for inline SQL. Optional `when` matches the same nested properties as mocks. `occurrence` selects the matching call entry (default 1). The default point is `BeforeCall`; `AfterCall` fires only when that selected invocation succeeds, before its caller continues or commits. An injected failure rolls back the owning transaction even if Method code catches it. Reports record fired rules in `failures`, with source locations and explicit omission counts. Disposal removes an unused rule without asserting that it fired.

Observers run synchronously after commit or rollback, receiving the same immutable report as `executions`. A failing observer raises `ObserverError` after notifying the remaining subscribers; it cannot undo committed work. Business and observer failures are retained together. Observers may inspect raw state; operations and control changes cannot reenter the world during notification. Subscriptions survive `reset()` until disposed or the world closes.

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

## Configured responses

Harness automatically loads `.harness/mocks.json`. Configure only the calls whose results you want to replace:

```json
[
    {
        "method": "ReadRequests",
        "when": { "state": "Open" },
        "response": "./responses/requests.json"
    }
]
```

Response paths resolve beside the declaring JSON file. JSON files return JSON in the native Result; `.txt` files return text; AML/XML files return Items. Inline responses accept `{ json: data }`, `{ text: value }`, `{ aml: xml }`, `{ error: message }`, or an explicit Item.

Tests can override individual calls while retaining other shared responses:

```ts
using harness = await createHarness({
    mocks: [
        {
            method: "ReadRequests",
            when: { state: "Open" },
            response: { json: { requests: [] } },
        },
    ],
});
```

An empty `mocks: []` disables shared responses. Configuration can supply `mocks: ["./other-mocks.json"]` instead of the conventional file. Local overrides take precedence for matching calls. Within a layer, the most specific property match wins; equally specific matches fail explicitly. Method names match case-insensitively, and property values match exactly.

The same dispatch handles direct calls, nested calls, and imported events. Matching calls skip source execution and C# compilation; unmocked calls execute normally. Responses are isolated per invocation and world. Traces label mocks and include their arguments, declaration, response file, and hash.

For SQL boundaries, `{ sql: "ProcedureName", response: ... }` replaces a named procedure. `{ sql: true, when: { method: "CallingMethod" }, response: ... }` replaces inline SQL from a particular Method without copying its SQL text into setup. Unmatched SQL still fails explicitly; no SQL engine is implied.

## C# and extensions

The C# executor starts lazily. It requires an installed .NET 10 SDK; its managed helper restores pinned Newtonsoft.Json 13.0.4 through NuGet. Harness does not install the SDK or depend on proprietary IOM/server assemblies. Original `method_code` is inserted unchanged into the managed template, with source mappings and hashes. Compiled artifacts are cached outside the repository.

The helper builds once per adapter version. Changed Methods compile directly through the installed SDK compiler without a project restore or MSBuild run. A warm managed process can serve successive worlds, with fresh invocation instances and isolated mutable statics. Only assemblies with no static storage beyond constants and supported dependencies retain JIT code across worlds. Unknown or process-global APIs and supplied reference assemblies keep process isolation. Reuse retires after 32 worlds, and idle processes close automatically.

`Console.Write`, `Console.WriteLine`, and `Console.Error` output appears in the Bun test terminal. The next test run reloads local package source and recompiles changed Methods. Mocked Methods return their configured response without executing or printing.

Managed `Item.node` is a live `System.Xml.XmlElement`. Methods can use `SelectSingleNode`, `SelectNodes`, predicates, axes, namespaces, attributes and text nodes through the native XPath engine. Item helpers and XML edits share the same tree, including nested Items and relationships. `getItemsByXPath` returns Item views backed by the selected source nodes. `removeProperty` removes a request property, its attributes and nested Item; omitting a field from an update preserves its stored value.

The XML adapter projects data into the existing Bun transport at call boundaries. It preserves numeric/null input values during inspection and rejects duplicate properties or unsupported nested XML shapes during transport rather than silently flattening them. Those limitations invalidate the owning request even if Method source catches the local exception. XML inspection alone does not change persisted records; ordinary actions still own validation, events and transactions.

```ts
export default {
    packages: ["./packages/solution/Import"],
    fixtures: ["./fixtures"],
    csharp: {
        references: ["./references/ProjectUtilities.dll"],
        timeoutMs: 30_000,
    },
} satisfies HarnessConfig;
```

Use `csharp: false` when no managed execution is needed. A Method calling `getUserID()` requires `session: { user: { login_name: "<login from imported data>" } }`; the selector resolves a real imported User record. It does not invent an account.

Native permission checks are opt-in:

```ts
import { AuthorizationMode } from "@innovatorstack/harness";
import type { HarnessConfig } from "@innovatorstack/harness";

export default {
    authorization: AuthorizationMode.Native,
    session: { user: { login_name: "test_user" } },
} satisfies HarnessConfig;
```

Import the User, Alias, Member, Permission/Access, Allowed Permission and Can Add records needed by
the solution. Reads filter inaccessible records before paging; writes, Method execution and lifecycle
roles check the imported rules. Owner, Manager and Creator resolve against each record. Temporary
identity grants pass through the same TypeScript authority and expire when the Method finishes,
including exceptions and worker timeouts. Effective membership dates use the controlled world clock.

Team roles resolve from each Item's `team_id` and its Team Identity records, including group membership.
The standard Team role includes every member; custom role Identities use classification `Team`.
These roles apply to ACL and lifecycle checks for that Item and do not enter the global session.

Creation checks use the imported `class_structure` and Can Add `class_path`. A grant includes its
declared descendants; a blank path covers the tree. Paths match names and case exactly. Classification
defaults and changes made by `onBeforeAdd` participate in the check. Unknown classes cannot authorize
creation, and malformed trees fail with a source diagnostic. Classifier APIs and native comparisons
remain separate work.

`AuthorizationMode.Unchecked` (and the existing `"unchecked"` value) selects behavior-only execution.
Policy callbacks remain supported. Without either choice, restricted operations require a policy.
Missing native ACL metadata fails explicitly. Inherited relationships copy their source's Permission,
owner, manager and Team; Creator stays with the relationship. Adding one needs source Update access.
Direct edits and deletions use the copied Update right. Permission and ownership changes propagate
through inherited relationships in the same transaction, including lifecycle changes and new
generations. Historical generations retain their own ACLs. Propagation runs without business hooks.
An authorized parent deletion removes its owned rows without granting those rights to Methods.
Fixtures retain their supplied stored ACL values; reads do not rewrite them. Related Items keep
their own permissions. Cycles, missing sources and excessive depth fail explicitly. Moving inherited
relationships, `for_all` source resolution, discovery and ABAC/MAC remain unavailable. Release-specific
native permission parity remains unverified.

Managed Methods support `Item.isNew()`, `Item.apply(action)`, `Innovator.getNewID()` and scoped
`CCO.Permissions.GrantIdentity`. New add Items receive an ID from the world's controlled stream before
`apply()`. `CCO.ErrorLookup.Lookup` formats a single imported UserMessage text; native localization and
language fallback are unavailable. Custom executors can use the optional `getNewId` and `security`
ports without changing ordinary test setup.

Advanced configuration accepts `modules` and `executors` as factories. Each world gets fresh instances. Module factories receive that world's storage and return the existing `HarnessModule` contract. Language executor factories return `MethodExecutor` implementations. Their reset/dispose hooks participate in world ownership.

Low-level APIs have separate entry points:

- `@innovatorstack/harness/engine`: explicit engine construction and instrumentation.
- `@innovatorstack/harness/core`: operations, module contracts, scoped execution.
- `@innovatorstack/harness/packages`: AML parsing/import contracts.
- `@innovatorstack/harness/storage/sqlite`: Bun SQLite storage and storage types.
- `@innovatorstack/harness/items`: native Item representation for application bridges.
- `@innovatorstack/harness/methods` and `/csharp`: executor contracts and managed execution.

## Current compatibility

Implemented: atomic AML imports; TypeScript/AML fixtures; get/add/edit/update/delete; automatic and manual generations; User-owned locks; metadata-driven lifecycle promotion; logical AML and literal-only WHERE queries; paging and exact decimal/date ordering; nested item selectors and relationship reads/actions; nested select projections; foreign properties; after-get hydration of federated response fields; version-1 before/after/replacement events; required hooks; nested transactions, rollback, traces, and managed reentry.

For add/edit/update, native AML `doGetItem="0"` returns type-and-ID Items after saving and running
mutation hooks. Full responses run Get after those hooks; its calculated properties, permissions
and failures participate in the same transaction. Fetch relationships explicitly when needed.
Lock/unlock with `doGetItem="0"` return the message `Ok.`; delete returns `Ok`. These messages
contain no Items. The flag does not suppress ordinary Get requests. Nested mutations default to
minimal responses unless their ItemType declares an after-mutation handler; explicit flags override
that default. Replacement Methods retain control of their own responses.

For an automatically versioned ItemType, `edit` locks, saves, and unlocks. The first save in a lock cycle creates a new ID, retains `config_id`, increments `generation`, and marks the previous generation as noncurrent. Further `update` calls during that lock cycle reuse the new generation. `version="0"` suppresses automatic versioning; `manual_versioning=1` requires the `version` action. These rules follow the [Aras Programmer's Guide](https://aras.com/wp-content/uploads/2025/06/Aras-Innovator-2025-Release-Programmers-Guide.pdf). Configure `session.user` in `.harness/config.ts` for versionable mutations.

For automatic versioning, `new_version` is `0` before the first save, becomes `1` after that
save, and returns to `0` on unlock. Locking an already owned Item preserves the marker.
Manual versioning preserves its stored marker and does not create generations implicitly.

Queries accept native `<and>`, `<or>`, `<not>`, repeated property conditions, comparisons,
`like`/`not like` (`%` and `_`), `in`/`not in`, `between`/`not between`, and null tests.
`where` accepts the same property-to-literal predicates with parentheses and qualified identifiers.
Values are bound separately from SQL. Decimal comparisons preserve text precision; dates preserve
up to seven fractional digits. Text matching is case-sensitive; item IDs are case-insensitive.
Installation-specific SQL Server collation and LIKE bracket classes remain unsupported.

`orderBy` runs before `page`/`pagesize` and `maxRecords`. Native `itemmax` and `pagemax` metadata
is available in `result.payload.messages` and C# response XML, including empty pages. Query work
is bounded to 512 predicates, 64 nesting levels, 10,000 values and 100,000 candidate rows.
Native release comparisons are still pending.

Nested relationship gets hydrate each parent's collection. Criteria filter parents before paging;
`isCriteria="0"` only hydrates. Nested item-property get/add/edit/update and relationship
add/edit/update/delete run through normal events in one transaction. Relationship mutations use
explicit child IDs. When a parent versions, those IDs resolve to the copied relationships,
leaving historical rows intact. Invalid ownership or a failed child action rolls back the graph.

Ordinary queries return current generations. An explicit ID, `generation`, or `is_current` selector can retrieve history. After submitting a Method, fetch by `config_id` and `is_current: 1` to inspect the resulting stored generation. Versioning clones current owned relationships, including versionable relationship records, as fresh configurations beneath the new parent. Original relationship histories remain intact. Version, update, lock, unlock, and transactional promotion effects share the caller's transaction and roll back together.

Fixed/floating item properties use exported `Property.item_behavior`. Relationships use their
stored `behavior`, RelationshipType defaults and source lifecycle `item_behavior`; hard policies
retain their precedence. Versioning updates floating references transactionally, freezes historical
relationships and points copied relationships at the latest related generation. Historical source
generations retain their references. An unspecified relationship policy defaults to fixed in the
current implementation; release-qualified native comparisons remain pending.

Deleting an owner removes its owned relationship records through normal event chains. Dependent
Items are removed when their last owning reference disappears, including item-property updates.
Other live references reject deletion. A Method or AML batch may create and attach dependent Items
within one request; orphan checks run before that outer request completes. Fixtures remain explicit
starting data and bypass business creation checks. Cascades, cleanup and validation share rollback,
execution reports and world reset behavior.

Versioning a released item advances its exported `Revision` sequence, retains `config_id`, increments
the generation and resets the lifecycle to its configured start state. Historical revision values, state
and dates remain readable. The new cycle clears release dates, applies start-state flags and permissions,
and recalculates copied relationship behavior. Sequence exhaustion rejects the request transactionally.
An explicit `version="0"` cannot save a released generation. Native release-specific comparisons remain
pending; change-management applications and released relationship cloning remain separate work.

Server Events use their exported `event_version`. Version-1 hooks run per item. Version-2
`onAfterAdd`, `onAfterUpdate` and `onAfterVersion` hooks receive the action collection;
`onBeforeCopy` and `onAfterCopy` receive relationship collections during parent versioning.
Before-copy hooks can alter copied values while retaining source identity and collection size.
Native suppression of business copy hooks during parent versioning remains unimplemented.
`Morphae` links supply inherited polymorphic bindings with concrete item contexts. Own and inherited
bindings share `sort_order`; tied orders within a phase fail explicitly. Required bindings survive
`serverEvents="0"`. Native release-specific event and clone parity remains unverified.
Automatic versioning runs before-update before deciding to create a generation. A hook can set
`version="0"` to save in place. When versioning starts, the selected batch uses the original pending
request and enters update again with new IDs, `oldId` and the automatic `new_version=1` marker.
Explicit version skips the initial update pass. Version hooks run despite `serverEvents="0"`;
optional update hooks remain suppressed. Before after-version hooks, versioning releases its historical
source locks. Every before-unlock hook runs before the batch is cleared; owned dependent Items are
unlocked before the after hooks. These writes and Method side effects share rollback and world reset.
Automatic source markers reset to zero; manual markers remain unchanged. Hook contexts containing
only type and ID are hydrated through Get and retain shared pending values across the unlock batch.
Administrative lock overrides, native event-data arguments and replacement interception during version
reentry remain unimplemented. Native event context profiles are still unverified.
Before-version Methods receive pending request values. Cloning preserves stored business values
until the subsequent update hooks finish; after-version Methods can query that intermediate clone.

Replacement Methods can delegate once to their native action through invocation-scoped
`MethodPorts.serverEvent.applyBase()`. C# `CSharpInOut` Methods receive native input/output XML
and typed event arguments, including `BaseLockItem`, `BaseUnlockItem` and `BasePromoteItem`.
Delegation retains authorization, before/after hooks and the owning transaction. Explicit lock/unlock
suppression skips optional hooks; `edit serverEvents="0"` still runs its implicit lock/unlock hooks.
Unknown Method templates and event argument types fail with explicit diagnostics.

Lifecycle bindings, states, transitions, and pre/post Methods come from imported AML. `add` uses the start state; `promoteItem` validates the transition and updates `state` and `current_state` without creating another generation. Transition roles require the configured authorization policy or the existing explicit `authorization: "unchecked"` setting. Transactional pre/post Methods execute through the same Method dispatcher and configured mocks.

Assigned classifications must be imported leaf paths or the unclassified root. Branches can
grant Can Add to their descendants. Native authorization checks the target class after before
hooks; an unchanged class needs no new creation grant. Changing lifecycle maps requires the
old map's start state, while class changes within the same map retain their current state.
Resets apply the new state's Permission before nested actions, then update state and owned
relationship behavior transactionally. Explicit `version` resets a released item before its
class update; ordinary edit/update validates against the previous lifecycle first.

When the imported schema requires `created_on` or `created_by_id`, normal `add` supplies omitted values from the current time and configured User session. Supplied values and fixture audit data remain intact. This covers required creation defaults; complete audit permission and modification policies remain separate work.

Still unsupported: released relationship cloning, minor revision policies, extended/polymorphic reference maintenance, standalone copy/clone actions, workflow startup, outside-transaction lifecycle post Methods, general T-SQL, advanced authorization policies, federated query predicates, advanced query forms, and browser Method execution. Full package import also needs native generated presentation metadata and explicitly supplied prerequisites.

Compiling a Method is not behavioral coverage.

## Work on the framework

```sh
bun install
bun run check
```

`check` runs formatting, readability lint, type checking, tests, and a clean package build. It writes framework results under `tests/results/`. Managed tests require .NET.

The core has no storage-driver, XML-parser, application, or transport imports. Framework implementation lives in `src/`; framework tests and generated results live in `tests/`, using the small test inputs in the root `.harness/`. Private consumer projects keep their own configuration, inputs, tests, and results outside the framework source. The managed C# helper and templates live beside their TypeScript adapter in `src/methods/csharp/managed/`. `scripts/` contains only the build and verification entry points.

`bun run release:check` packs the distribution, audits its contents and runs both examples
as fresh consumers of that archive.
The verified archive and check results are saved under `tests/results/`.
Published source maps include their framework TypeScript targets for debugging and declaration
navigation. The release check rejects missing sources and local build intermediates.

This is a 0.1 preview. The implemented behavior and remaining gaps are listed above.
