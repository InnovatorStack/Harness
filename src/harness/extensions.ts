import type { HarnessModule } from "../core/types.js";
import type { MethodExecutor } from "../methods/types.js";
import type { HarnessStorage } from "../storage/types.js";

export type ModuleFactory = (storage: HarnessStorage) => HarnessModule;

export type ExecutorFactory = () => MethodExecutor;

export function moduleFactories(value: unknown): readonly ModuleFactory[] {
    return factories(value, "modules").map((create) => (storage) => {
        const module: unknown = create(storage);

        if (!isModule(module)) {
            throw new Error("A Harness module factory must return a valid module.");
        }

        return module;
    });
}

export function executorFactories(value: unknown): readonly ExecutorFactory[] {
    return factories(value, "executors").map((create) => () => {
        const executor: unknown = create();

        if (!isMethodExecutor(executor)) {
            throw new Error("A Harness executor factory must return a language executor.");
        }

        return executor;
    });
}

function factories(
    value: unknown,
    name: string,
): readonly ((...arguments_: unknown[]) => unknown)[] {
    if (value === undefined) {
        return [];
    }

    if (!Array.isArray(value) || value.length > 1000) {
        throw new TypeError(`Harness '${name}' must be an array of factories.`);
    }

    return value.map((factory) => {
        if (!isFactory(factory)) {
            throw new TypeError(`Each Harness '${name}' entry must create a fresh instance.`);
        }

        return (...arguments_: unknown[]): unknown => factory(...arguments_);
    });
}

function isMethodExecutor(value: unknown): value is MethodExecutor {
    return (
        isObject(value) &&
        typeof value.language === "string" &&
        typeof value.execute === "function" &&
        optionalFunction(value.reset) &&
        optionalFunction(value.dispose)
    );
}

function isModule(value: unknown): value is HarnessModule {
    return (
        isObject(value) &&
        typeof value.id === "string" &&
        typeof value.setup === "function" &&
        optionalFunction(value.reset) &&
        optionalFunction(value.dispose) &&
        (value.requires === undefined ||
            (Array.isArray(value.requires) && value.requires.every((id) => typeof id === "string")))
    );
}

function optionalFunction(value: unknown): boolean {
    return value === undefined || typeof value === "function";
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function isFactory(value: unknown): value is (...arguments_: unknown[]) => unknown {
    return typeof value === "function";
}
