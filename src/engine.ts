import { openEngine } from "./engine/instance.js";
import type { Engine, EngineOptions } from "./engine/instance.js";

export type { Engine, EngineOptions } from "./engine/instance.js";

/** Open a platform world with the built-in baseline and optional engine extensions. */
export function createEngine(options: EngineOptions = {}): Engine {
    return openEngine(options);
}
