import { join } from "node:path";

import type { HarnessModule } from "../core/types.js";
import type { Engine } from "../engine.js";
import { captureEngine, openEngine } from "../engine/instance.js";
import { loadFixtureRecords } from "../fixtures/module.js";
import { csharp } from "../methods/csharp/index.js";
import type { MethodFile } from "../methods/sources.js";
import type { MethodExecutor } from "../methods/types.js";
import { loadAmlDocuments } from "../packages/files.js";
import { PlatformError } from "../platform/errors.js";
import { matches } from "../platform/query.js";
import { SqliteStorage } from "../storage/sqlite/storage.js";
import { loadConfiguration, resolveCSharpOptions } from "./configuration.js";
import type { HarnessOptions, ResolvedConfig } from "./configuration.js";
import { loadTypeScriptFixtures, readTypeScriptFixtures, splitFixturePaths } from "./fixtures.js";
import { readMethodFiles } from "./method-files.js";
import { runtimeIdentity } from "./runtime-identity.js";
import { setupCache } from "./setup-cache.js";
import { readSetupImage, writeSetupImage } from "./setup-image.js";
import { parseSetupSources, readSetupSources, setupKey } from "./setup-inputs.js";
import { Harness } from "./world.js";

/** Open a world from shared .harness configuration, with optional local overrides. */
export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
    const configuration = await loadConfiguration(options);
    const methodFiles = await readMethodFiles(
        configuration.directory,
        configuration.settings.methods,
    );
    const fixtures = await splitFixturePaths(configuration.fixtures);

    if (
        (configuration.settings.modules?.length ?? 0) > 0 ||
        typeof configuration.settings.authorization === "function"
    ) {
        const packages = await loadAmlDocuments(configuration.packages.map((path) => ({ path })));
        const records = await loadAmlDocuments(fixtures.aml.map((path) => ({ path })));
        const engine = createConfiguredEngine(
            configuration,
            { packages, fixtures: records },
            methodFiles,
        );

        return await finishSetup(engine, async () => {
            await loadTypeScriptFixtures(engine, fixtures.typescript);
            engine.checkpoint();
        });
    }

    const sources = await readSetupSources([...configuration.packages, ...fixtures.aml]);
    const records = await readTypeScriptFixtures(fixtures.typescript);
    const key = setupKey(
        configuration,
        sources,
        configuration.packages.length,
        records,
        await runtimeIdentity(),
    );
    const path = join(configuration.harnessDirectory, "cache", "setup.bin");
    const image = setupCache.get(key) ?? (await readSetupImage(path, key)) ?? setupCache.get(key);

    if (image) {
        setupCache.put(key, image);
    }

    const engine = createConfiguredEngine(
        configuration,
        image ?? {
            packages: parseSetupSources(sources.slice(0, configuration.packages.length)),
            fixtures: parseSetupSources(sources.slice(configuration.packages.length)),
        },
        methodFiles,
    );

    return await finishSetup(engine, async () => {
        if (!image) {
            if (fixtures.typescript.length > 0) {
                engine.runtime.executeSync(loadFixtureRecords, records);
            }

            engine.checkpoint();
            setupCache.put(key, captureEngine(engine));
            await writeSetupImage(path, key, captureEngine(engine));
        }
    });
}

async function finishSetup(engine: Engine, prepare: () => Promise<void>): Promise<Harness> {
    try {
        await prepare();

        return new Harness(engine);
    } catch (error) {
        try {
            engine.close();
        } catch (cleanup) {
            throw new AggregateError([error, cleanup], "Harness setup and cleanup failed.", {
                cause: cleanup,
            });
        }

        throw error;
    }
}

function createConfiguredEngine(
    configuration: ResolvedConfig,
    setup: Parameters<typeof openEngine>[1],
    methodFiles: readonly MethodFile[],
): Engine {
    const storage = new SqliteStorage();
    const executors: MethodExecutor[] = [];
    const modules: HarnessModule[] = [];
    let engine: Engine | undefined;
    let transferred = false;

    try {
        if (configuration.settings.csharp !== false) {
            executors.push(csharp(resolveCSharpOptions(configuration)));
        }

        for (const createExecutor of configuration.settings.executors ?? []) {
            executors.push(createExecutor());
        }

        for (const createModule of configuration.settings.modules ?? []) {
            modules.push(createModule(storage));
        }

        transferred = true;
        engine = openEngine(
            {
                storage,
                ...(configuration.settings.clock ? { clock: configuration.settings.clock } : {}),
                ...(configuration.settings.ids ? { ids: configuration.settings.ids } : {}),
                executors,
                mocks: configuration.mocks,
                methodFiles,
                modules,
                ...(configuration.settings.authorization !== undefined
                    ? { authorization: configuration.settings.authorization }
                    : {}),

                userId: () => resolveUser(configuration, storage),
            },
            setup,
        );

        return engine;
    } catch (error) {
        try {
            if (engine) {
                engine.close();
            } else {
                closeUnattached(storage, transferred ? [] : modules, transferred ? [] : executors);
            }
        } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], "Harness setup and cleanup failed.", {
                cause: cleanupError,
            });
        }

        throw error;
    }
}

function resolveUser(configuration: ResolvedConfig, storage: SqliteStorage): string {
    const selector = configuration.settings.session?.user;

    if (!selector || Object.keys(selector).length === 0) {
        throw new PlatformError(
            "SessionRequired",
            "This Method requires session.user in .harness/config.ts.",
        );
    }

    const definition = storage.getItemType("User");

    if (!definition) {
        throw new PlatformError("MissingItemType", "The User ItemType is not imported.");
    }

    const users = storage
        .listItems("User")
        .filter((user) =>
            Object.entries(selector).every(([name, value]) =>
                matches(storage, definition, user, { name, value }),
            ),
        );
    const user = users[0];

    if (users.length !== 1 || !user) {
        throw new PlatformError(
            "SessionResolution",
            `session.user matched ${users.length} records; expected one.`,
        );
    }

    return user.id;
}

function closeUnattached(
    storage: SqliteStorage,
    modules: readonly HarnessModule[],
    executors: readonly MethodExecutor[],
): void {
    const failures: unknown[] = [];

    for (const resource of [...modules, ...executors].reverse()) {
        try {
            resource.dispose?.();
        } catch (error) {
            failures.push(error);
        }
    }

    try {
        storage.close();
    } catch (error) {
        failures.push(error);
    }

    if (failures.length > 0) {
        throw new AggregateError(failures, "Unattached setup resource cleanup failed.");
    }
}
