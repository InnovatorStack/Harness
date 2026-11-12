import type { HarnessConfig } from "../src/index.js";

export default {
    packages: ["./packages/pipeline/Import"],
    fixtures: ["./fixtures/baseline.ts"],
    csharp: false,
} satisfies HarnessConfig;
