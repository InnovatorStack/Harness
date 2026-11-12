import type { MockRegistry } from "../mocks/registry.js";
import { MockCoverage } from "./types.js";
import type { MockCheck } from "./types.js";

export function checkMocks(
    registry: MockRegistry | undefined,
    kind: "method" | "sql",
    names: readonly string[],
): MockCheck {
    if (!registry) {
        return Object.freeze({ coverage: MockCoverage.Unknown, rules: Object.freeze([]) });
    }

    const rules = registry.describe(kind, names);
    const unconditional = rules.filter((rule) => Object.keys(rule.when).length === 0);
    let coverage = MockCoverage.None;

    if (unconditional.length > 0) {
        let highestLayer = -Infinity;

        for (const rule of unconditional) {
            highestLayer = Math.max(highestLayer, rule.layer);
        }

        const winners = unconditional.filter((rule) => rule.layer === highestLayer);
        coverage = winners.length > 1 ? MockCoverage.Ambiguous : MockCoverage.Unconditional;
    } else if (rules.length > 0) {
        coverage = MockCoverage.Conditional;
    }

    return Object.freeze({ coverage, rules });
}
