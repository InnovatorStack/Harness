import { expect, test } from "bun:test";

import { cloneData } from "../src/core/data.js";
import { ExecutionOutcome } from "../src/index.js";
import { compareData, compareObservations } from "./reference/compare.js";
import { normalizeObservation } from "./reference/normalize.js";
import {
    fixedId,
    otherId,
    firstId,
    secondId,
    linkId,
    sampleObservation,
} from "./reference/samples.js";
import type { Observation } from "./reference/types.js";

const anchors = new Set([fixedId, otherId]);

test("ID aliases stay consistent across results, events, history and relationship graphs", () => {
    const expected = sampleObservation();
    const actual = sampleObservation(secondId, "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF");
    expect(compareObservations(expected, actual, anchors).matches).toBe(true);
    const normalized = normalizeObservation(expected, anchors);
    const node = normalized.steps[0]?.response.items[0];
    expect(node?.attributes.id).toBe("@generated:1");
    expect(node?.properties.config_id).toBe(fixedId);
    expect(node?.properties.note).toBe(firstId);
    expect(expected.steps[0]?.response.items[0]?.attributes.id).toBe(firstId);
    expect(Object.isFrozen(normalized.steps)).toBe(true);
});

test("state row ordering does not depend on random IDs or insertion order", () => {
    const expected = sampleObservation();
    const actual: Observation = {
        ...expected,
        initial: [...expected.initial].reverse(),
        steps: expected.steps.map((step) => ({ ...step, state: [...step.state].reverse() })),
    };
    expect(compareObservations(expected, actual, anchors).matches).toBe(true);
});

test("wrong fixed references, generations, lifecycle values and outcomes survive normalization", () => {
    const expected = sampleObservation();
    const mutations = [
        (observation: Observation) => {
            Reflect.set(
                observation.steps[0]?.response.items[0]?.properties ?? {},
                "config_id",
                otherId,
            );
        },
        (observation: Observation) => {
            Reflect.set(
                observation.steps[0]?.response.items[0]?.properties ?? {},
                "generation",
                "3",
            );
        },
        (observation: Observation) => {
            Reflect.set(
                observation.steps[0]?.response.items[0]?.properties ?? {},
                "state",
                "Released",
            );
        },
        (observation: Observation) => {
            Reflect.set(observation.steps[0] ?? {}, "outcome", ExecutionOutcome.RolledBack);
        },
    ];

    for (const mutate of mutations) {
        const actual = cloneData(expected);
        mutate(actual);
        expect(compareObservations(expected, actual, anchors).matches).toBe(false);
    }
});

test("unknown relationship targets remain literal and do not acquire invented identity aliases", () => {
    const expected = sampleObservation();
    const actual = cloneData(expected);
    const link = actual.steps[0]?.state.find((record) => record.id === linkId);

    if (!link) {
        throw new Error("The sample must contain a relationship.");
    }

    Reflect.set(link.properties, "related_id", "99999999999999999999999999999999");
    const comparison = compareObservations(expected, actual, anchors);
    expect(comparison.matches).toBe(false);
    expect(
        comparison.differences.some((difference) => difference.path.endsWith("/related_id")),
    ).toBe(true);
});

test("event order and contexts compare exactly and ambiguous state keys fail explicitly", () => {
    const expected = sampleObservation();
    const first = expected.steps[0];

    if (!first) {
        throw new Error("The sample needs a step.");
    }

    const actual: Observation = {
        ...expected,
        steps: [{ ...first, events: [...first.events, ...first.events] }],
    };
    expect(compareObservations(expected, actual, anchors).matches).toBe(false);
    expect(() =>
        normalizeObservation(
            { ...expected, initial: [...expected.initial, ...expected.initial] },
            anchors,
        ),
    ).toThrow("Ambiguous reference identity");
});

test("comparison preserves null, empty, missing, dates, decimal text and ID-shaped business values", () => {
    for (const [expected, actual] of [
        [null, ""],
        [{ note: null }, {}],
        ["1.00", "1"],
        ["2026-01-01", "2026-01-02"],
        [firstId, secondId],
    ]) {
        expect(compareData(expected, actual).matches).toBe(false);
    }

    expect(compareData({ "a/b~c": "old" }, { "a/b~c": "new" }).differences[0]?.path).toBe(
        "/a~1b~0c",
    );
    expect(
        compareData(
            Array.from({ length: 200 }, () => 1),
            Array.from({ length: 200 }, () => 2),
        ),
    ).toMatchObject({ matches: false, truncated: true });
});

test("comparison rejects unsafe input trees without evaluating accessors", () => {
    const unsafe = {
        get value(): never {
            throw new Error("Do not run this accessor");
        },
    };
    expect(() => compareData(unsafe, {})).toThrow("accessors");
    expect(() => compareData({ value: Number.NaN }, {})).toThrow();
});
