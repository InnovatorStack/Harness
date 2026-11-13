---
title: "Fixtures"
---

Fixtures are the starting records your tests need. A TypeScript fixture file groups them by imported ItemType. These names and
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
