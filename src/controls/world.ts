import type { RuntimeObserver } from "../core/types.js";
import { ExecutionRecorder } from "../instrumentation/recorder.js";
import type { HarnessStorage } from "../storage/types.js";
import { executionObserver } from "./execution.js";
import { FailureRegistry } from "./failures.js";
import { ExecutionObservers } from "./observers.js";
import { WorldValues } from "./values.js";
import type { ValueSettings } from "./values.js";

/** Each world owns its controls, report retention and subscription lifetimes. */
export class WorldControls {
    readonly values: WorldValues;
    readonly recorder: ExecutionRecorder;
    readonly failures: FailureRegistry;
    readonly observers = new ExecutionObservers();
    readonly observer: RuntimeObserver;

    constructor(storage: HarnessStorage, settings: ValueSettings) {
        this.values = new WorldValues(settings);
        this.recorder = new ExecutionRecorder({}, () => this.values.clock.now());
        this.failures = new FailureRegistry((execution, evidence, target) => {
            this.recorder.injected(execution, evidence, target);
        });
        this.observer = executionObserver(storage, this.recorder, this.failures, this.observers);
    }

    close(): void {
        this.failures.reset();
        this.observers.close();
    }
}
