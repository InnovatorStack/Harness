---
title: "Compatibility"
---

Harness is a local platform implementation. Passing a test in Harness is not a native-server comparison. Check a solution's dependencies and exercise the paths it uses before relying on the result.

## Check a solution

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

## Coverage at a glance

| Area             | Available                                                            | Current limits                                                                     |
| ---------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Package loading  | Atomic XML imports, references, source locations and hashes.         | Supply dependencies explicitly; presentation metadata does not imply UI execution. |
| Data and actions | Fixtures, queries, writes, versioning, relationships and rollback.   | See the platform guides for supported action and reference profiles.               |
| C#               | Original server source through the .NET adapter, live XML and XPath. | Supported templates and API subset; unsupported paths fail explicitly.             |
| Permissions      | Imported native ACLs, identities, team roles and scoped grants.      | Opt-in; some advanced policies and relationship moves remain unsupported.          |
| SQL              | Named and inline call mocks.                                         | General T-SQL execution is not implemented.                                        |
| Browser code     | Keep UI tests separate from Harness.                                 | Browser Method execution is not implemented.                                       |

## Remaining gaps

Released relationship cloning, minor revision policies, extended reference maintenance, standalone copy/clone actions, workflow startup, post-commit lifecycle Methods, advanced authorization policies and federated query predicates remain unsupported. Moving retained XML nodes into new containers and generation reentry after a document replacement also remain guarded.

Source compilation, observed execution and native verification are separate facts in a compatibility report. Dynamic calls and unexercised branches remain unknown. Native executable parity has not been established.
