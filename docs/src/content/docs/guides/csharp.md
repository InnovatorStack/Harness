---
title: "Run C# Methods"
---

The C# executor starts lazily. It requires an installed .NET 10 SDK; its managed helper restores pinned Newtonsoft.Json 13.0.4 through NuGet. Harness does not install the SDK or depend on proprietary IOM/server assemblies. Original `method_code` is inserted unchanged into the managed template, with source mappings and hashes. Compiled artifacts are cached outside the repository.

## Working Method files

Available in Harness 0.2.0 and later.

Map a Method name to the C# file you are editing:

```ts
// .harness/config.ts
import type { HarnessConfig } from "@innovatorstack/harness";

export default {
    methods: {
        SubmitReview: "../src/SubmitReview.cs",
    },
} satisfies HarnessConfig;
```

Paths resolve relative to the configuration file. The file contains the normal Aras Method body,
including its `MethodTemplateName` comment when needed. Its filename can differ from the Method name.

Harness uses the file instead of the package's `method_code`, retaining imported IDs, execution
permissions and event bindings. Direct calls, nested calls and hooks share this resolution. Package
files and stored package definitions stay unchanged. A mapped C# Method can also be called without a
package definition; the mapping supplies its name, not event or permission metadata.

A missing file or parent directory falls back to the imported implementation. If neither exists,
calling the Method fails normally. An existing file that cannot be read or compiled fails explicitly;
runtime failures follow normal rollback. These errors never fall back to package code. Explicit mocks
still take precedence over source execution.

Each `createHarness()` reads the mapped files anew. Changes, creation and deletion are picked up even
when package setup is cached. A running world retains its original source selection through `reset()`;
open a new world to load edits. Automatic watch triggering for external C# files is not provided.

Per-world `methods` entries override shared names case-insensitively and retain other mappings.
Use `methods: {}` to disable all shared mappings for that world.

Execution calls expose the actual location in `source` and the effective body hash in `sourceHash`.
`methodSource` records `MethodSourceKind.LocalFile` or `MethodSourceKind.Package`, the `configuredFile`,
whether `fallback` occurred and the original `packageSource` when available. Compatibility checks
inspect and optionally compile that same effective source while keeping the package inventory intact.

The [server Methods example](https://github.com/InnovatorStack/Harness/tree/main/examples/server-methods)
uses a working C# file with its original package and hooks.

## Compilation and reuse

The helper builds once per adapter version. Changed Methods compile directly through the installed SDK compiler without a project restore or MSBuild run. A warm managed process can serve successive worlds, with fresh invocation instances and isolated mutable statics. Only assemblies with no static storage beyond constants and supported dependencies retain JIT code across worlds. Unknown or process-global APIs and supplied reference assemblies keep process isolation. Reuse retires after 32 worlds, and idle processes close automatically.

`Console.Write`, `Console.WriteLine`, and `Console.Error` output appears in the Bun test terminal. The next test run reloads local package source and recompiles changed Methods. Mocked Methods return their configured response without executing or printing.

## XML and XPath

Managed `Item.node` is a live `System.Xml.XmlElement`. Methods can use `SelectSingleNode`, `SelectNodes`, predicates, axes, namespaces, attributes and text nodes through the native XPath engine. Item helpers and XML edits share the same tree, including nested Items and relationships. `getItemsByXPath` returns Item views backed by the selected source nodes. `removeProperty` removes a request property, its attributes and nested Item; omitting a field from an update preserves its stored value.

The XML adapter projects data into the existing Bun transport at call boundaries. It preserves numeric/null input values during inspection and rejects duplicate properties or unsupported nested XML shapes during transport rather than silently flattening them. Those limitations invalidate the owning request even if Method source catches the local exception. XML inspection alone does not change persisted records; ordinary actions still own validation, events and transactions.

## Reference assemblies

```ts
// .harness/config.ts
import type { HarnessConfig } from "@innovatorstack/harness";

export default {
    csharp: {
        references: ["./references/ProjectUtilities.dll"],
        timeoutMs: 30_000,
    },
} satisfies HarnessConfig;
```

Use `csharp: false` when no managed execution is needed. A Method calling `getUserID()` requires `session: { user: { login_name: "<login from imported data>" } }`; the selector resolves a real imported User record. It does not invent an account.

## SDK helpers and custom executors

Managed Methods support `Item.isNew()`, `Item.apply(action)`, `Innovator.getNewID()` and scoped
`CCO.Permissions.GrantIdentity`. New add Items receive an ID from the world's controlled stream before
`apply()`. `CCO.ErrorLookup.Lookup` formats a single imported UserMessage text; native localization and
language fallback are unavailable. Custom executors can use the optional `getNewId` and `security`
ports without changing ordinary test setup.

Advanced configuration accepts `modules` and `executors` as factories. Each world gets fresh instances. Module factories receive that world's storage and return the existing `HarnessModule` contract. Language executor factories return `MethodExecutor` implementations. Their reset/dispose hooks participate in world ownership.
