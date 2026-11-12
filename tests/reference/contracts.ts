import type { Observation, StepObservation } from "./types.js";

export function requireContract(condition: boolean, message: string): asserts condition {
    if (!condition) {
        throw new Error(`Reference contract: ${message}`);
    }
}

export function stepAt(observation: Observation, index: number): StepObservation {
    const step = observation.steps[index];
    requireContract(step !== undefined, `Missing step ${index}.`);

    return step;
}

export function resultId(observation: Observation, index: number): string {
    const id = stepAt(observation, index).response.items[0]?.attributes.id;
    requireContract(typeof id === "string" && id.length > 0, `Step ${index} must return an ID.`);

    return id;
}

export function valueAt(observation: Observation, index: number, property: string) {
    return stepAt(observation, index).response.items[0]?.properties[property];
}

export function equalContract(actual: unknown, expected: unknown, message: string): void {
    requireContract(Bun.deepEquals(actual, expected), message);
}

export function unchanged(observation: Observation): void {
    equalContract(
        observation.steps.at(-1)?.state,
        observation.initial,
        "A rejected transaction must retain its entire starting graph.",
    );
}
