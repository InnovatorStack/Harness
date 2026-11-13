---
title: "Configuration"
---

Configuration is optional. Put shared settings in `.harness/config.ts`; override only what a particular suite or test needs.

```ts
import type { HarnessConfig } from "@innovatorstack/harness";

export default {
    packages: ["../../shared-packages"],
    csharp: { timeoutMs: 30_000 },
    session: { user: { login_name: "test_user" } },
} satisfies HarnessConfig;
```

## Paths

Shared paths resolve relative to `.harness/config.ts`. Harness always includes `.harness/packages/`, plus configured extra package paths. It automatically discovers `fixtures.ts`, the `fixtures/` folder and `mocks.json`. Test files stay outside `.harness`.

An explicit per-world fixture list replaces the shared fixture list. An empty `mocks: []` disables shared mocks; a nonempty list overrides matching calls and retains the others.

```ts
using world = await createHarness({
    fixtures: ["./fixtures/submission.ts"],
    mocks: [],
});
```

## Common settings

| Setting                | Use it for                                                                        |
| ---------------------- | --------------------------------------------------------------------------------- |
| `packages`             | Additional package paths; conventional packages always load.                      |
| `fixtures`             | Explicit shared data inputs.                                                      |
| `methods`              | Method names mapped to working source files; missing files fall back to packages. |
| `mocks`                | Extra JSON mock files or per-world rules.                                         |
| `session.user`         | Selecting an imported User for identity, locks and permissions.                   |
| `csharp`               | Reference assemblies and execution timeout; `false` disables managed execution.   |
| `authorization`        | Native permissions or a custom policy.                                            |
| `clock`, `ids`         | Deterministic test values.                                                        |
| `modules`, `executors` | Extension factories for a world.                                                  |

See [C# Methods](/Harness/guides/csharp/), [permissions](/Harness/reference/permissions/) and [test controls](/Harness/guides/test-controls/) for complete examples.
