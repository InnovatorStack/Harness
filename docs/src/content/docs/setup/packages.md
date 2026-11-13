---
title: "Package loading"
---

Harness always loads XML under `.harness/packages/`. Keep the folder structure produced by your export tool.

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

## Check dependencies

```ts
import { verifyPackages, PackageIssueCode } from "@innovatorstack/harness";

const report = await verifyPackages();
const missing = report.issues.filter((issue) => issue.code === PackageIssueCode.MissingDependency);
```

Verification uses the same configuration and package discovery as normal setup. It checks imports against the built-in baseline in a disposable in-memory database. Issues contain typed codes, source locations, conflicting sources and unresolved reference details where available. Readable files are still inventoried when another input fails.

`canImport` describes metadata import into Harness. `methods` and `sql` list supplied source declarations, including patches, with their hashes and locations. Verification does not compile or execute those bodies. Fixtures, mock response files and executor factories are outside this check; ordinary world setup still loads them.
