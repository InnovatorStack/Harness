# Framework tests

Run `bun run check` from the repository root. It checks formatting, lint, types, framework tests, and the package build. Open [results/README.md](./results/README.md) for the latest result and Bun test report.

`tests/` contains framework tests only. The root `.harness/` supplies their small `TestNode`/`TestLink` package and shared starting data. Framework tests also construct isolated temporary setups when testing configuration discovery and failure handling.

For focused checks:

```sh
bun test tests/setup.test.ts
bun test tests/actions.test.ts
bun test tests/csharp.test.ts
```

`sqlite-checkpoint.test.ts` covers savepoint resets, clean connection reuse, disposed-world isolation,
concurrent worlds and durable file-backed commits.

`setup-cache.test.ts`, `setup-image.test.ts` and `metadata-reuse.test.ts` cover snapshot reuse,
fresh-process loading, changed inputs, detached metadata and rollback. `managed-worker.test.ts`
checks static isolation, process retirement and normal Bun script shutdown. `parsed-data.test.ts`
checks the bounded JSON transport; `csharp-xml.test.ts` checks live DOM mutation tracking.

`bun run release:check` audits the public repository and packed archive, then installs fresh
consumers for both public examples and the README/skill code samples. Each consumer passes
strict types, formatting, Oxlint, structural style checks and Bun tests. The verified archive
and evidence stay under `results/`. Repository audit tests also reject ignored files that
have been staged for publication. Source-map checks cover every emitted JavaScript/declaration
reference and its packaged TypeScript target; packaging tests exclude managed intermediates.
These checks do not establish native platform parity.

## Reference behavior suite

`tests/reference/` owns original AML, fixture data, C# Methods, cases, comparison rules and native-evidence validation. It uses no customer packages or connections. The 89 cases run through the ordinary dispatcher and managed adapter in `AuthorizationMode.Native`, with explicit User/Alias/Member, Can Add and Permission/Access data. They use no mocks or injected failures.

Action response cases check minimal write acknowledgements, fetch-back of the new generation,
lock/unlock messages and deletion messages. Unit tests also cover nested response defaults,
real C# fetch-back, write-only ACLs and rollback when a return Get fails.

Classification cases cover creation grants, invalid branch values, same-map changes, rejected
map switches, unchanged classes and scoped C# reclassification with state permissions. Unit
tests cover generation history, nested permissions, relationship behavior, rollback and reset.
Versioning contracts also assert native `new_version` values through a complete lock cycle.

Update reentry cases cover source-controlled version suppression, both before-update passes,
their action/ID contexts and transactional rejection in either phase. Unit tests cover shared
before-version request data, mixed bulk version markers, idlist order, permission timing and reset.

Generated replacement cases cover base delegation, skipped updates, response ownership, rollback and
explicit/automatic WHERE criteria. Unit tests exercise single/bulk ID lists, manual versioning,
nested relationship ID remapping, captured targets/flags, permission changes, port expiry and reset.

Base-input tests exercise real source through both C# templates. Generated IDs, selector changes,
captured flags, property insertion/removal, nulls, implicit query groups and expanded Item properties
update retained XML nodes. They cover source-visible base faults, caught synchronization failures,
transaction rollback and isolated reset. A 3 MiB unchanged value verifies that request synchronization
does not duplicate business data into callback messages. The portable base-input contract remains
pending native evidence.
Relationship-request cases retain surviving XML, Item, attribute and text views across changed
repeated IDs, anonymous additions, removal, reordering and identical cloned replacements. Private
origins survive clones, nested relationship actions/queries and managed event returns without
entering business AML or stored records.
Tests reject malformed, duplicated, foreign and over-budget origins, and cover failure/reset/world
isolation plus retained managed Items from earlier invocations. Two portable contracts exercise
original Methods with repeated and anonymous requests; native evidence remains pending. Unqualified
base-delegate and version-generation document replacements retain explicit diagnostics and rollback.

Property-Item cases verify changed and identical imported copies through real replacement and
before-version Methods. Unit tests cover both C# templates, nested query properties, retained/detached
XML and Item views, wrapper attributes, same/foreign-document arguments, return values, failure,
reset and world isolation. Document-view tests separate selections from their shared XML, including
reloads, detached nodes, independent native fields, scalar/fault inspection, whole-document returns,
selected-Item application and self-insertion. Failure cases cover both templates, rollback, reset and
separate worlds. Two portable contracts cover document views and selected-Item returns; offline
SDK observations qualify local adapter behavior, not native server execution.
Captured-request tests distinguish the action's retained node from the document later hooks see.
They cover default Get/Add, versionable and nonversionable per-record updates, both C# templates,
changes before/after detachment, rollback and reset/world isolation. Protocol tests reject replaced
retained roots, conflicting data and conflicting child identities before mutating caller objects.
A portable Get contract exercises the captured query and both original hooks. Version-generation
document replacement remains explicitly unsupported. Replacement Methods also
prove that caught reloads before BaseGet/BaseUpdate reject and roll back; BaseAdd reparses its
reloaded input, following its separate native capture point.

Base-document tests use both C# templates to retain original XML nodes through a default Get/Add
base call while later hooks see a reloaded document with its actual wrappers and comments. They
cover returned faults, nested rollback, controlled reset and separate worlds. XML/data mismatches
reject before changing caller objects. Identical data cannot hide changed Item origins; moving
retained nodes into new XML containers keeps an explicit guard. Ordinary unchanged inputs retain
sparse synchronization, including the 3 MiB regression case.

Add-identity cases verify that default Add allocates a missing or empty ID after replacement
dispatch and before before-hooks. Original Methods inspect IDs before/after BaseAdd in both C#
templates. Tests cover SDK preallocation, explicit IDs, nested allocation order, rejection rollback,
abandoned work and reset/world isolation. Before-hooks changing the captured ID fail explicitly.
Two portable contracts cover default allocation through the original replacement and before-hook;
native executable comparisons remain pending.

Failure-context tests cover returned faults and exceptions from one or multiple before-version
Methods, normalized batch selectors and nested generated replacements. Pending input changes
survive while stored writes roll back. Invalid or oversized failure data produces explicit diagnostics;
large exception text is marked truncated, and subsequent calls and resets remain usable.

Event-response cases distinguish shared input mutations from separate Item/text/null returns,
after-Get response hydration, zero-code hook rejection and ordinary null Method responses.
Unit tests cover both C# templates, chained hooks, paging metadata, rollback, reset, mocked faults
and handled no-items results from nested ordinary Methods. These local contracts remain pending
native executable comparisons.

Historical unlock cases cover locked/unlocked sources, callback order, event suppression and rejection.
Unit tests also exercise automatic/manual markers, real Get hydration, shared contexts, owned dependent
cascades, other owners, bounded cycles/depth, resumed callbacks after rollback and generated User targets.

Event metadata tests execute both C# templates against historical after-version Items and empty
version-2 contexts. They check complete ID mappings, before-update ID lists, persisted after-add data,
rejection of mapped writes, mixed binding order and shared per-item pending values. Custom executor
tests check immutable snapshots, nested ordinary calls, independent worlds and reset isolation.
Portable batch cases use native argument IDs to query data instead of expecting result collections.

Bound-Method permission cases cover native `NoCheck` inheritance, protected data and ordinary calls
after the hook returns. Unit tests exercise before/after and replacement hooks, both event versions,
mocks, direct versus nested lifecycle Methods, transition roles, concurrent sibling operations,
independent runtimes, rollback, abandoned callbacks and reset. This changes no consumer setup API.

The cases cover nonversionable edits, nullable clears, required values, lock ownership, first/subsequent saves, version suppression, manual versioning, current/history queries, event order, required/replacement events, promotion, nested rollback, grouped queries, paging metadata, relationship hydration, fixed/floating references, historical freezing, dependent deletion, collection contexts, collection rejection rollback and versionable relationship cloning, copied lifecycle initialization, released revision resets, sequence exhaustion and revision rejection. Permission cases cover owner filtering, batch rollback on denial, access changes, disabled creation rights, class paths and defaults, hook reclassification, Method execution identities, scoped C# grants, inherited relationship reads and mutations, copied ACL propagation and rollback, parent-authorized owned deletion, per-item Team roles, membership changes and lifecycle roles.

Parent-version copy cases verify stored values, fresh configurations and suppressed business copy hooks.
Unit tests cover both event versions, required/optional flags, inherited bindings, all versioning entry
actions, unused mocks/executors, nested records, later source rejection, foreign values and explicit
diagnostics for native file-container copies and released relationship resets.

Copied-lifecycle tests exercise classification defaults, missing maps, native-mode state permissions,
nested reference changes, source history and original C# after-version Methods. Method rejection and
injected failure restore the full graph; world reset also restores controlled IDs and clocks without
changing another world. Reset callbacks, workflow startup and released start-state date initialization
retain explicit capability diagnostics. Local contracts do not establish native parity.

Run it outside the test runner:

```sh
bun run scripts/reference.ts
```

Open `tests/results/reference/report.json` for responses, event Method contexts and raw stored state after every step. `inputs.json` contains the original setup AML, request templates, fixture selectors, projected columns, identity fields, event bindings, authorization mode, session selector, local clock/ID controls and per-case input hashes. Each case resets to the fixture checkpoint. Template bindings resolve fixture selectors or a previous single-item result to its ID.

Stored projections contain only columns in the imported schema. Shared platform tables declare `sourceIds` to limit snapshots to relationships owned by the reference fixtures; native evidence containing unrelated rows is rejected. Clock and ID controls make local runs deterministic. Native captures retain their server's actual values, with comparison limited to the declared projections.

Local contract results and native comparisons have separate statuses. Default runs report `PENDING_NATIVE_REFERENCE`; they never write native recordings or mark platform capabilities as reference-verified. A stale recording, mismatch, invalid recording or failed local contract fails the suite. With `--require-native`, missing native outcomes also fail:

```sh
bun run scripts/reference.ts --native /path/to/reviewed-profile --require-native
```

The native directory is read-only input and must contain one release/build profile. Each `<case-id>.json` has this envelope around a complete observation in the same shape as a local run:

```json
{
    "schemaVersion": 1,
    "source": "native-aras",
    "caseId": "nonversionable-edit",
    "inputHash": "<SHA-256 from inputs.json>",
    "profile": { "release": "<actual release>", "build": "<actual build>" },
    "recordedAt": "<ISO timestamp with timezone>",
    "review": {
        "reviewer": "<reviewer>",
        "reviewedAt": "<ISO timestamp with timezone>",
        "evidence": "<review or capture artifact reference>"
    },
    "observation": { "initial": [], "steps": [] }
}
```

The empty observation above is only a shape illustration; validation rejects it. Actual outcomes must come from a dedicated disposable native reference environment using the supplied original setup and requests. Install the metadata and restore fixture data administratively, then authenticate as `reference_owner` for the requests. Restore the original fixture state between cases, retain the response/error and transaction outcome, and read the watched stored columns within their declared source scopes after each request. The suite contains no native writer or connection adapter.

For native event capture, the original test Methods emit `HARNESS_REFERENCE_EVENT|<Method>|<Base64 AML>` when the native server process has `INNOVATOR_HARNESS_REFERENCE_CAPTURE=1`. This is inactive by default. Capture these lines per request, including failed transactions; `readNativeEvents()` in `tests/reference/native-events.ts` decodes them offline and derives event labels from original metadata through `nativeEventBindings()`. Native evidence requires review; its metadata is an attestation, not automatic proof of origin. Synthetic comparator samples are test inputs, never native evidence.

Comparison preserves result/event order, contexts, errors, generations, state, nulls, empty text and decimal/date text. Stored snapshots are sets ordered by declared unique business keys. Declared stored columns include SQL null when absent; payload property presence remains distinct. Only declared identity fields are mapped consistently across owned records, results, contexts and relationships. Original input IDs remain anchored; unknown references and ID-shaped business strings remain literal. Timing and other native audit fields outside the declared projection are not compared. This suite makes no concurrency, deadlock, distributed-transaction or external-effect claim.
