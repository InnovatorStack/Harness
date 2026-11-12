import type { RuntimeObserver } from "../core/types.js";
import type { ExecutionRecorder } from "../instrumentation/recorder.js";
import type { HarnessStorage } from "../storage/types.js";
import type { FailureRegistry } from "./failures.js";
import type { ExecutionObservers } from "./observers.js";
import { injectionTarget } from "./targets.js";

/** Internal boundary hooks preserve the single request transaction for direct and nested calls. */
export function executionObserver(
    storage: HarnessStorage,
    recorder: ExecutionRecorder,
    failures: FailureRegistry,
    observers: ExecutionObservers,
): RuntimeObserver {
    return {
        started(execution, input) {
            recorder.started(execution, input);

            if (failures.hasRules) {
                const target = injectionTarget(storage, execution.operation, input);

                if (target) {
                    failures.enter(execution, target);
                }
            }
        },

        completed(execution, result) {
            recorder.completed(execution, result);
            failures.complete(execution);
        },

        failed(execution, error) {
            failures.failed(execution);
            recorder.failed(execution, error);
        },

        settled(requestId, outcome, error) {
            failures.settled(requestId);
            recorder.settled(requestId, outcome, error);
            const report = recorder.executions.at(-1);

            if (report?.requestId === requestId) {
                observers.notify(report);
            }
        },

        reset() {
            failures.reset();
            recorder.reset();
        },
    };
}
