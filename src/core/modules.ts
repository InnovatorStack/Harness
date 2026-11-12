import { RuntimeError } from "./errors.js";
import { setupFilesMax } from "./limits.js";
import type { HarnessModule } from "./types.js";

export function orderModules(modules: readonly HarnessModule[]): readonly HarnessModule[] {
    if (modules.length > setupFilesMax) {
        throw new RuntimeError("InvalidModule", "Too many modules were supplied.");
    }

    const byId = new Map<string, HarnessModule>();

    for (const module of modules) {
        if (module.id.trim().length === 0) {
            throw new RuntimeError("InvalidModule", "A module needs a non-empty ID.");
        }

        if (byId.has(module.id)) {
            throw new RuntimeError(
                "DuplicateModule",
                `Module "${module.id}" was supplied more than once.`,
            );
        }

        byId.set(
            module.id,
            Object.freeze({
                id: module.id,
                ...(module.requires === undefined
                    ? {}
                    : { requires: Object.freeze([...module.requires]) }),
                setup: module.setup.bind(module),
                ...(module.reset === undefined ? {} : { reset: module.reset.bind(module) }),
                ...(module.dispose === undefined ? {} : { dispose: module.dispose.bind(module) }),
            }),
        );
    }

    return visitModules(byId);
}

interface ModuleFrame {
    readonly module: HarnessModule;
    next: number;
}

function visitModules(byId: ReadonlyMap<string, HarnessModule>): readonly HarnessModule[] {
    const ordered: HarnessModule[] = [];
    const completed = new Set<string>();
    const active = new Set<string>();

    for (const module of byId.values()) {
        if (completed.has(module.id)) {
            continue;
        }

        const pending: ModuleFrame[] = [{ module, next: 0 }];
        active.add(module.id);

        while (pending.length > 0) {
            const frame = pending.at(-1);

            if (!frame) {
                throw new Error("A module frame must exist while ordering is pending.");
            }

            const id = frame.module.requires?.[frame.next];

            if (id === undefined) {
                pending.pop();
                active.delete(frame.module.id);
                completed.add(frame.module.id);
                ordered.push(frame.module);
                continue;
            }

            frame.next += 1;
            const dependency = byId.get(id);

            if (!dependency) {
                throw new RuntimeError(
                    "MissingModule",
                    `Module "${frame.module.id}" requires missing module "${id}".`,
                );
            }

            if (completed.has(id)) {
                continue;
            }

            if (active.has(id)) {
                const chain = [...pending.map((frame) => frame.module.id), id].join(" -> ");

                throw new RuntimeError("ModuleCycle", `Module dependency cycle: ${chain}.`);
            }

            active.add(id);
            pending.push({ module: dependency, next: 0 });
        }
    }

    return ordered;
}
