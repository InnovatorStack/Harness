import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { clockSettings } from "../controls/clock.js";
import type { ClockSettings } from "../controls/clock.js";
import { idSettings } from "../controls/ids.js";
import type { IdSettings } from "../controls/ids.js";
import { setOwn } from "../core/data.js";
import type { CSharpOptions } from "../methods/csharp/compiler.js";
import { loadMocks, mockInputs } from "../mocks/configuration.js";
import type { MockRegistry } from "../mocks/registry.js";
import type { MockInput } from "../mocks/types.js";
import { resolvePackageFiles } from "../packages/files.js";
import type { PackageInputError } from "../packages/files.js";
import type { PlatformOptions } from "../platform/engine.js";
import { AuthorizationMode } from "../platform/security/types.js";
import type { StorageValue } from "../storage/types.js";
import { executorFactories, moduleFactories } from "./extensions.js";
import type { ExecutorFactory, ModuleFactory } from "./extensions.js";
import { methodMappings, mergeMethodMappings } from "./method-files.js";
import { loadSetupModule } from "./setup-module.js";

export interface HarnessConfig {
    readonly clock?: ClockSettings;
    readonly ids?: IdSettings;
    /** Additional inputs, relative to the config file. .harness/packages is always loaded. */
    readonly packages?: readonly string[];
    readonly fixtures?: readonly string[];
    /** Working Method bodies, relative to the configuration file. Missing files use packages. */
    readonly methods?: Readonly<Record<string, string>>;
    readonly csharp?: CSharpOptions | false;
    readonly authorization?: PlatformOptions["authorization"];
    readonly session?: { readonly user: Readonly<Record<string, StorageValue>> };
    readonly modules?: readonly ModuleFactory[];
    readonly executors?: readonly ExecutorFactory[];
    readonly mocks?: readonly MockInput[];
}

export interface HarnessOptions extends HarnessConfig {
    readonly cwd?: string;
    readonly config?: string | HarnessConfig;
}

export interface ResolvedConfig {
    readonly harnessDirectory: string;
    readonly directory: string;
    readonly settings: HarnessConfig;
    readonly packages: readonly string[];
    readonly fixtures: readonly string[];
    readonly mocks: MockRegistry;
}

export interface ResolvedSettings {
    readonly directory: string;
    readonly harnessDirectory: string;
    readonly configured: HarnessConfig;
    readonly settings: HarnessConfig;
}

export interface PackageConfiguration extends ResolvedSettings {
    readonly packages: readonly string[];
}

/** Managed paths follow the same config-directory semantics during execution and inspection. */
export function resolveCSharpOptions(
    configuration: Pick<PackageConfiguration, "settings" | "directory">,
): CSharpOptions {
    const options =
        configuration.settings.csharp === false ? {} : (configuration.settings.csharp ?? {});
    const references = options.references?.map((path) => resolve(configuration.directory, path));
    const cacheDirectory = options.cacheDirectory
        ? resolve(configuration.directory, options.cacheDirectory)
        : undefined;

    return {
        ...options,
        ...(references ? { references } : {}),
        ...(cacheDirectory ? { cacheDirectory } : {}),
    };
}

export async function loadConfiguration(options: HarnessOptions): Promise<ResolvedConfig> {
    const resolved = await resolveSettings(options);
    const { directory, configured, settings } = resolved;
    const packages = await resolvePackages(resolved);
    const fixtures = settings.fixtures ?? (await defaultFixtures(directory));

    return {
        harnessDirectory: resolved.harnessDirectory,
        directory,
        settings,
        packages,
        fixtures: fixtures.map((path) => resolve(directory, path)),
        mocks: await loadMocks(directory, configured.mocks, options.mocks),
    };
}

/** Package inspection shares configuration and discovery without starting world setup. */
export async function loadPackageConfiguration(
    options: Pick<HarnessOptions, "cwd" | "config" | "packages">,
    onError: (error: PackageInputError) => void,
): Promise<readonly string[]> {
    return (await loadPackageSettings(options, onError)).packages;
}

/** Inspection reads shared settings without loading fixtures or constructing extensions. */
export async function loadPackageSettings(
    options: HarnessOptions,
    onError: (error: PackageInputError) => void,
): Promise<PackageConfiguration> {
    const resolved = await resolveSettings(options);

    return { ...resolved, packages: await resolvePackages(resolved, onError) };
}

async function resolveSettings(options: HarnessOptions): Promise<ResolvedSettings> {
    const cwd = resolve(options.cwd ?? process.cwd());
    const harnessDirectory = (await findHarnessDirectory(cwd)) ?? join(cwd, ".harness");
    let directory = harnessDirectory;
    let configured: HarnessConfig = {};

    if (typeof options.config === "object") {
        const candidate: unknown = options.config;

        if (!isObject(candidate)) {
            throw new Error("Harness config must be an object.");
        }

        configured = parseConfiguration(candidate, "inline configuration");
    } else {
        const candidate = join(directory, "config.ts");
        let path: string | undefined;

        if (typeof options.config === "string") {
            path = resolve(cwd, options.config);
        } else if (await Bun.file(candidate).exists()) {
            path = candidate;
        }

        if (path) {
            directory = dirname(path);
            const imported = await loadSetupModule(path);

            if (!isObject(imported) || !isObject(imported.default)) {
                throw new Error(`${path} must default-export a Harness configuration object.`);
            }

            configured = parseConfiguration(imported.default, path);
        } else if (typeof options.config === "string") {
            throw new TypeError(`Harness configuration '${options.config}' does not exist.`);
        }
    }

    const overrides = Object.fromEntries(
        Object.entries(options).filter(([name]) => name !== "cwd" && name !== "config"),
    );
    const merged = { ...configured, ...overrides };
    const methods = mergeMethodMappings(configured.methods, options.methods);

    if (methods !== undefined) {
        merged.methods = methods;
    }

    if (typeof configured.csharp === "object" && typeof options.csharp === "object") {
        merged.csharp = { ...configured.csharp, ...options.csharp };
    }

    const settings = parseConfiguration(merged, "configuration overrides");

    return { directory, harnessDirectory, configured, settings };
}

async function resolvePackages(
    resolved: ResolvedSettings,
    onError?: (error: PackageInputError) => void,
): Promise<readonly string[]> {
    const { directory, harnessDirectory, settings } = resolved;
    const automaticPackages = await defaultPackages(harnessDirectory, onError);
    const additionalPackages = await resolvePackageFiles(
        (settings.packages ?? []).map((path) => ({ path: resolve(directory, path) })),
        onError ? { onError } : {},
    );

    // An additional path may overlap the conventional directory; import each physical file once.
    return [...new Set([...automaticPackages, ...additionalPackages])];
}

async function findHarnessDirectory(start: string): Promise<string | undefined> {
    let directory = start;

    while (true) {
        const candidate = join(directory, ".harness");

        if (await exists(candidate)) {
            return candidate;
        }

        const parent = dirname(directory);

        if (parent === directory) {
            return undefined;
        }

        directory = parent;
    }
}

async function defaultPackages(
    directory: string,
    onError?: (error: PackageInputError) => void,
): Promise<readonly string[]> {
    const path = join(directory, "packages");

    if (!(await exists(path))) {
        return [];
    }

    return await resolvePackageFiles([{ path }], {
        allowEmptyDirectories: true,
        ...(onError ? { onError } : {}),
    });
}

async function defaultFixtures(directory: string): Promise<string[]> {
    const paths: string[] = [];

    for (const name of ["fixtures.ts", "fixtures"]) {
        const path = join(directory, name);

        if (await exists(path)) {
            paths.push(path);
        }
    }

    return paths;
}

async function exists(path: string): Promise<boolean> {
    try {
        await stat(path);

        return true;
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return false;
        }

        throw error;
    }
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function paths(value: unknown, name: string): readonly string[] | undefined {
    if (value === undefined) {
        return undefined;
    }

    if (
        !Array.isArray(value) ||
        value.length > 20_000 ||
        !value.every((path): path is string => typeof path === "string" && path.length > 0)
    ) {
        throw new Error(`Harness '${name}' must be an array of non-empty paths.`);
    }

    return value;
}

function parseConfiguration(value: Record<string, unknown>, path: string): HarnessConfig {
    validateConfigurationKeys(value, path);

    const configuration: { -readonly [Key in keyof HarnessConfig]: HarnessConfig[Key] } = {
        ...parseInputs(value),
    };

    const clock = clockSettings(value.clock);
    const ids = idSettings(value.ids);

    if (clock !== undefined) {
        configuration.clock = clock;
    }

    if (ids !== undefined) {
        configuration.ids = ids;
    }

    if (value.modules !== undefined) {
        configuration.modules = moduleFactories(value.modules);
    }

    if (value.executors !== undefined) {
        configuration.executors = executorFactories(value.executors);
    }

    if (value.mocks !== undefined) {
        configuration.mocks = mockInputs(value.mocks);
    }

    if (value.csharp === false) {
        configuration.csharp = false;
    } else if (value.csharp !== undefined) {
        configuration.csharp = parseCSharp(value.csharp);
    }

    if (value.authorization === AuthorizationMode.Native) {
        configuration.authorization = AuthorizationMode.Native;
    } else if (value.authorization === AuthorizationMode.Unchecked) {
        configuration.authorization = AuthorizationMode.Unchecked;
    } else if (isAuthorization(value.authorization)) {
        const authorize = value.authorization;
        configuration.authorization = async (request) => {
            await authorize(request);
        };
    } else if (value.authorization !== undefined) {
        throw new Error("Harness authorization must be an AuthorizationMode or a policy callback.");
    }

    const session = parseSession(value.session);

    if (session) {
        configuration.session = session;
    }

    return configuration;
}

function parseInputs(
    value: Record<string, unknown>,
): Pick<HarnessConfig, "packages" | "fixtures" | "methods"> {
    const packages = paths(value.packages, "packages");
    const fixtures = paths(value.fixtures, "fixtures");
    const methods = methodMappings(value.methods);

    return {
        ...(packages ? { packages } : {}),
        ...(fixtures ? { fixtures } : {}),
        ...(methods !== undefined ? { methods } : {}),
    };
}

function parseCSharp(value: unknown): CSharpOptions {
    if (!isObject(value)) {
        throw new Error("Harness csharp must be an options object or false.");
    }

    const options: {
        dotnet?: string;
        cacheDirectory?: string;
        references?: readonly string[];
        timeoutMs?: number;
    } = {};

    for (const key of ["dotnet", "cacheDirectory"] as const) {
        const entry = value[key];

        if (entry !== undefined) {
            if (typeof entry !== "string") {
                throw new TypeError(`csharp.${key} must be a string.`);
            }

            options[key] = entry;
        }
    }

    const references = paths(value.references, "csharp.references");

    if (references) {
        options.references = references;
    }

    if (value.timeoutMs !== undefined) {
        if (
            typeof value.timeoutMs !== "number" ||
            !Number.isSafeInteger(value.timeoutMs) ||
            value.timeoutMs <= 0 ||
            value.timeoutMs > 2_147_483_647
        ) {
            throw new Error("csharp.timeoutMs must be a positive number.");
        }

        options.timeoutMs = value.timeoutMs;
    }

    return options;
}

function parseSession(value: unknown): HarnessConfig["session"] {
    if (value !== undefined) {
        if (!isObject(value) || !isObject(value.user)) {
            throw new Error("Harness session.user must select an imported User record.");
        }

        const user: Record<string, StorageValue> = {};

        for (const [key, entry] of Object.entries(value.user)) {
            if (
                entry !== null &&
                typeof entry !== "string" &&
                (typeof entry !== "number" || !Number.isFinite(entry))
            ) {
                throw new Error(`Invalid User selector '${key}'.`);
            }

            setOwn(user, key, entry);
        }

        return { user };
    }

    return undefined;
}

function validateConfigurationKeys(value: Record<string, unknown>, path: string): void {
    const supported = new Set([
        "clock",
        "ids",
        "packages",
        "fixtures",
        "methods",
        "csharp",
        "authorization",
        "session",
        "modules",
        "executors",
        "mocks",
    ]);

    for (const key of Object.keys(value)) {
        if (!supported.has(key)) {
            throw new Error(`Unknown Harness configuration key '${key}' in ${path}.`);
        }
    }
}

function isAuthorization(value: unknown): value is (request: unknown) => unknown {
    return typeof value === "function";
}
