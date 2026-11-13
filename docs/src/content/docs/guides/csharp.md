---
title: "Run C# Methods"
---

The C# executor starts lazily. It requires an installed .NET 10 SDK; its managed helper restores pinned Newtonsoft.Json 13.0.4 through NuGet. Harness does not install the SDK or depend on proprietary IOM/server assemblies. Original `method_code` is inserted unchanged into the managed template, with source mappings and hashes. Compiled artifacts are cached outside the repository.

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
