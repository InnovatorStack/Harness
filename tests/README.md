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

`tests/reference/` owns original AML, fixture data, C# Methods, cases, comparison rules and native-evidence validation. It uses no customer packages or connections. The 56 cases run through the ordinary dispatcher and managed adapter in `AuthorizationMode.Native`, with explicit User/Alias/Member, Can Add and Permission/Access data. They use no mocks or injected failures.

Action response cases check minimal write acknowledgements, fetch-back of the new generation,
lock/unlock messages and deletion messages. Unit tests also cover nested response defaults,
real C# fetch-back, write-only ACLs and rollback when a return Get fails.

The cases cover nonversionable edits, nullable clears, required values, lock ownership, first/subsequent saves, version suppression, manual versioning, current/history queries, event order, required/replacement events, promotion, nested rollback, grouped queries, paging metadata, relationship hydration, fixed/floating references, historical freezing, dependent deletion, collection contexts, collection rejection rollback and versionable relationship cloning, released revision resets, sequence exhaustion and revision rejection. Permission cases cover owner filtering, batch rollback on denial, access changes, disabled creation rights, class paths and defaults, hook reclassification, Method execution identities, scoped C# grants, inherited relationship reads and mutations, copied ACL propagation and rollback, parent-authorized owned deletion, per-item Team roles, membership changes and lifecycle roles.

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
