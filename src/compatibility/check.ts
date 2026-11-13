import { setOwn } from "../core/data.js";
import { errorMessage } from "../core/errors.js";
import type { MethodDefinition } from "../methods/types.js";
import { loadMocks } from "../mocks/configuration.js";
import type { MockRegistry } from "../mocks/registry.js";
import type { PlatformCatalog } from "../platform/catalog.js";
import { PlatformError } from "../platform/errors.js";
import type { StorageValue, CatalogEntry } from "../storage/types.js";
import { inspectPackages } from "../verification/inspection.js";
import type { PackageInspection } from "../verification/inspection.js";
import type { PackageMethodDeclaration, PackageSqlDeclaration } from "../verification/types.js";
import { capabilities, CapabilityId, capabilityForLanguage } from "./capabilities.js";
import { ExecutionEvidence } from "./executions.js";
import { ExecutorInspection } from "./executors.js";
import { inspectMetadata } from "./metadata.js";
import { inspectMethodSources } from "./method-sources.js";
import { checkMocks } from "./mocks.js";
import { resolveDeclaration } from "./sources.js";
import {
    CompilationStatus,
    CompatibilityIssueCode,
    ExecutorStatus,
    IssueSeverity,
    MockCoverage,
} from "./types.js";
import type {
    CompatibilityIssue,
    CompatibilityOptions,
    CompatibilityReport,
    CompilationCheck,
    ExecutorCheck,
    MethodCompatibility,
    MockCheck,
    SqlCompatibility,
} from "./types.js";

/** Preflight supplied metadata and execution boundaries without running business source or
 * fixtures. */
export async function checkCompatibility(
    options: CompatibilityOptions = {},
): Promise<CompatibilityReport> {
    const { compile = false, executions = [], ...settings } = options;

    if (typeof compile !== "boolean") {
        throw new TypeError("Compatibility compile must be a boolean.");
    }

    if (!Array.isArray(executions)) {
        throw new TypeError("Compatibility executions must be an array of execution reports.");
    }

    const evidence = new ExecutionEvidence(executions);
    using inspection = await inspectPackages(settings);
    const configuration = inspection.configuration;
    const issues: CompatibilityIssue[] = [];
    const mocks = await inspectMockSettings(inspection, settings, issues);

    issues.push(...metadataIssues(inspection));

    const executors = configuration
        ? new ExecutorInspection(
              configuration,
              inspection.storage.listCatalogEntries("Server Event"),
          )
        : undefined;
    const methods: MethodCompatibility[] = [];
    const methodSources = await inspectMethodSources(inspection);

    for (const declaration of methodSources.declarations) {
        const method = await inspectMethod(
            inspection,
            methodSources.catalog,
            declaration,
            mocks,
            executors,
            compile,
            evidence,
        );
        methods.push(method);
        issues.push(...method.issues);
    }

    const sql = inspection.report.sql.map((declaration) =>
        inspectSql(inspection, declaration, mocks, evidence),
    );

    for (const definition of sql) {
        issues.push(...definition.issues);
    }

    issues.push(...evidence.issues);

    return Object.freeze({
        packages: inspection.report,
        capabilities,
        methods: Object.freeze(methods),
        sql: Object.freeze(sql),
        issues: Object.freeze(uniqueIssues(issues)),
        limitations: Object.freeze([
            "Preflight does not execute business source or fixture modules. Execution evidence comes only from supplied reports; native reference behavior remains unverified.",
            "Dynamic Method names, generated AML, branch coverage and external effects remain unknown until exercised.",
            "Metadata warnings identify boundaries that may be reached; unused definitions do not establish a failing workflow.",
        ]),
    });
}

function metadataIssues(inspection: PackageInspection): CompatibilityIssue[] {
    const configuration = inspection.configuration;
    const issues: CompatibilityIssue[] = [];

    if (inspection.report.canImport && configuration) {
        issues.push(
            ...inspectMetadata(
                inspection.storage,
                new Set(inspection.report.documents.map((document) => document.path)),
                configuration.settings,
            ),
        );
    } else {
        issues.push(
            issue(
                CompatibilityIssueCode.PackageImportFailed,
                IssueSeverity.Error,
                "Package metadata did not import completely. See packages.issues; effective definitions cannot be checked reliably.",
            ),
        );
    }

    return issues;
}

async function inspectMethod(
    inspection: PackageInspection,
    catalog: PlatformCatalog,
    declaration: PackageMethodDeclaration,
    registry: MockRegistry | undefined,
    executors: ExecutorInspection | undefined,
    compile: boolean,
    evidence: ExecutionEvidence,
): Promise<MethodCompatibility> {
    const entry = inspection.report.canImport
        ? resolveDeclaration(inspection.storage, "Method", declaration)
        : undefined;
    const names = (
        entry ? [entry.id, entry.properties.name] : [declaration.id, declaration.name]
    ).filter((name): name is string => typeof name === "string");
    const mocks = checkMocks(registry, "method", names);
    const issues = mockIssues(mocks, declaration.source);
    const fullyMocked = mocks.coverage === MockCoverage.Unconditional;
    const definition = resolveMethod(catalog, entry, declaration, fullyMocked, issues);
    const language = definition?.language ?? declaration.language;
    const executor: ExecutorCheck = executors
        ? await executors.executor(language, Boolean(definition) && !fullyMocked)
        : Object.freeze({ status: ExecutorStatus.Unknown });
    inspectExecutor(definition, fullyMocked, executor, issues);
    const compilation = await compilationCheck(
        definition,
        mocks,
        executor.status,
        executors,
        compile,
    );
    inspectCompilation(compilation, definition?.source ?? declaration.source, issues);
    let summary: Omit<MethodDefinition, "code"> | undefined;

    if (definition) {
        const { code: _code, ...identity } = definition;
        summary = Object.freeze(identity);
    }

    const observations = definition
        ? evidence.observations("Method", definition.id, definition.hash, definition.source)
        : Object.freeze([]);

    return Object.freeze({
        declaration,
        ...(summary ? { definition: summary } : {}),
        executor,
        mocks,
        compilation,
        issues: Object.freeze(issues),
        executed: observations.some((observation) => observation.executed),
        observations,
        referenceVerified: false,
    });
}

async function compilationCheck(
    definition: MethodDefinition | undefined,
    mocks: MockCheck,
    executor: ExecutorStatus,
    inspection: ExecutorInspection | undefined,
    requested: boolean,
): Promise<CompilationCheck> {
    if (mocks.coverage === MockCoverage.Unconditional) {
        return Object.freeze({ status: CompilationStatus.SkippedMock });
    }

    if (!definition) {
        return Object.freeze({ status: CompilationStatus.Unresolved });
    }

    if (!requested) {
        return Object.freeze({ status: CompilationStatus.NotRequested });
    }

    if (
        mocks.coverage === MockCoverage.Unknown ||
        mocks.coverage === MockCoverage.Ambiguous ||
        executor !== ExecutorStatus.Available ||
        !inspection
    ) {
        return Object.freeze({ status: CompilationStatus.Unavailable });
    }

    if (definition.language.toLowerCase() !== "c#") {
        return Object.freeze({ status: CompilationStatus.Unsupported });
    }

    return await inspection.compile(definition);
}

function inspectSql(
    inspection: PackageInspection,
    declaration: PackageSqlDeclaration,
    registry: MockRegistry | undefined,
    evidence: ExecutionEvidence,
): SqlCompatibility {
    const entry = inspection.report.canImport
        ? resolveDeclaration(inspection.storage, "SQL", declaration)
        : undefined;
    const name = entry?.properties.name ?? declaration.name;
    const mocks = checkMocks(registry, "sql", typeof name === "string" ? [name] : []);
    const issues = mockIssues(mocks, declaration.source);

    if (mocks.coverage !== MockCoverage.Unconditional) {
        issues.push(
            Object.freeze({
                ...issue(
                    CompatibilityIssueCode.UnsupportedCapability,
                    IssueSeverity.Warning,
                    `SQL '${name ?? declaration.id ?? "unnamed"}' has no native executor; a matching SQL mock is required when invoked.`,
                ),
                capability: CapabilityId.TSql,
                causeCode: "UnsupportedSQL",
                source: declaration.source,
            }),
        );
    }

    const definition = sqlDefinition(entry, name);

    const observations = definition
        ? evidence.observations(
              "SQL",
              definition.id,
              definition.bodyHashes.sqlserver_body,
              definition.source,
          )
        : Object.freeze([]);

    return Object.freeze({
        declaration,
        ...(definition ? { definition } : {}),
        executor: Object.freeze({
            status: ExecutorStatus.Missing,
            message: "No built-in T-SQL executor.",
        }),
        mocks,
        issues: Object.freeze(issues),
        executed: observations.some((observation) => observation.executed),
        observations,
        referenceVerified: false,
    });
}

function sqlDefinition(
    entry: CatalogEntry | undefined,
    name: StorageValue | undefined,
): SqlCompatibility["definition"] {
    if (entry && typeof name === "string") {
        const bodyHashes: Record<string, string> = {};

        for (const [property, value] of Object.entries(entry.properties)) {
            if (property.endsWith("_body") && typeof value === "string") {
                setOwn(
                    bodyHashes,
                    property,
                    new Bun.CryptoHasher("sha256").update(value).digest("hex"),
                );
            }
        }

        return Object.freeze({
            id: entry.id,
            name,
            source: entry.source,
            bodyHashes: Object.freeze(bodyHashes),
        });
    }

    return undefined;
}

function mockIssues(
    mocks: MockCheck,
    source: PackageMethodDeclaration["source"],
): CompatibilityIssue[] {
    if (mocks.coverage === MockCoverage.Conditional) {
        return [
            Object.freeze({
                ...issue(
                    CompatibilityIssueCode.ConditionalMock,
                    IssueSeverity.Warning,
                    "Mocks match only some parameters. Nonmatching calls execute the original source.",
                ),
                source,
            }),
        ];
    }

    if (mocks.coverage === MockCoverage.Ambiguous) {
        return [
            Object.freeze({
                ...issue(
                    CompatibilityIssueCode.AmbiguousMock,
                    IssueSeverity.Error,
                    "Unconditional mocks at the same override layer are ambiguous.",
                ),
                source,
            }),
        ];
    }

    return [];
}

function issue(
    code: CompatibilityIssueCode,
    severity: IssueSeverity,
    message: string,
): CompatibilityIssue {
    return Object.freeze({ code, severity, message });
}

function uniqueIssues(issues: readonly CompatibilityIssue[]): readonly CompatibilityIssue[] {
    const unique = new Map<string, CompatibilityIssue>();

    for (const issue of issues) {
        const key = JSON.stringify([issue.code, issue.causeCode, issue.message, issue.source]);
        unique.set(key, issue);
    }

    return [...unique.values()];
}

async function inspectMockSettings(
    inspection: PackageInspection,
    settings: CompatibilityOptions,
    issues: CompatibilityIssue[],
): Promise<MockRegistry | undefined> {
    const configuration = inspection.configuration;
    let mocks: MockRegistry | undefined;

    if (configuration) {
        try {
            mocks = await loadMocks(
                configuration.directory,
                configuration.configured.mocks,
                settings.mocks,
            );
        } catch (error) {
            issues.push(
                issue(
                    CompatibilityIssueCode.InvalidMocks,
                    IssueSeverity.Error,
                    errorMessage(error),
                ),
            );
        }

        if (
            (configuration.settings.modules?.length ?? 0) > 0 ||
            (configuration.settings.executors?.length ?? 0) > 0
        ) {
            issues.push(
                issue(
                    CompatibilityIssueCode.ExtensionNotInspected,
                    IssueSeverity.Information,
                    "Custom module and executor factories are not constructed by preflight; their capabilities require runtime inspection.",
                ),
            );
        }
    }

    return mocks;
}

function resolveMethod(
    catalog: PlatformCatalog,
    entry: CatalogEntry | undefined,
    declaration: PackageMethodDeclaration,
    fullyMocked: boolean,
    issues: CompatibilityIssue[],
): MethodDefinition | undefined {
    let definition: MethodDefinition | undefined;

    const identifier =
        entry?.id ?? (declaration.action === "source" ? declaration.name : undefined);

    if (identifier) {
        try {
            definition = catalog.method(identifier);
        } catch (error) {
            if (!(error instanceof PlatformError)) {
                throw error;
            }

            if (!fullyMocked) {
                issues.push(
                    Object.freeze({
                        ...issue(
                            CompatibilityIssueCode.InvalidDefinition,
                            IssueSeverity.Error,
                            error.message,
                        ),
                        source: error.source ?? declaration.source,
                        causeCode: error.code,
                    }),
                );
            }
        }
    }

    return definition;
}

function inspectExecutor(
    definition: MethodDefinition | undefined,
    fullyMocked: boolean,
    executor: ExecutorCheck,
    issues: CompatibilityIssue[],
): void {
    const language = definition?.language ?? "";

    if (
        definition &&
        !fullyMocked &&
        ![ExecutorStatus.Available, ExecutorStatus.Unknown].includes(executor.status)
    ) {
        const capability = capabilityForLanguage(language);
        issues.push(
            Object.freeze({
                ...issue(
                    CompatibilityIssueCode.ExecutorUnavailable,
                    IssueSeverity.Error,
                    executor.message ?? `No '${language}' executor is available.`,
                ),
                ...(capability !== undefined ? { capability } : {}),
                source: definition.source,
                causeCode:
                    executor.status === ExecutorStatus.Missing ||
                    executor.status === ExecutorStatus.Disabled
                        ? "MissingExecutor"
                        : "CSharpUnavailable",
            }),
        );
    }
}

function inspectCompilation(
    compilation: CompilationCheck,
    source: PackageMethodDeclaration["source"],
    issues: CompatibilityIssue[],
): void {
    if (compilation.status === CompilationStatus.Failed) {
        issues.push(
            Object.freeze({
                ...issue(
                    CompatibilityIssueCode.CompilationFailed,
                    IssueSeverity.Error,
                    compilation.message ?? "C# compilation failed.",
                ),
                capability: CapabilityId.CSharp,
                causeCode: "MethodCompilationFailed",
                source,
            }),
        );
    }
}
