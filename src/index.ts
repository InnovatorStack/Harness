export { createHarness } from "./harness/create.js";
export { MethodSourceKind } from "./methods/sources.js";
export type { MethodSourceResolution } from "./methods/sources.js";
export { AuthorizationMode } from "./platform/security/types.js";
export {
    checkCompatibility,
    CapabilityId,
    CapabilitySupport,
    CompatibilityIssueCode,
    IssueSeverity,
    ExecutorStatus,
    MockCoverage,
    CompilationStatus,
} from "./compatibility/index.js";
export type {
    CapabilityDescriptor,
    CompatibilityOptions,
    CompatibilityReport,
    CompatibilityIssue,
    MethodCompatibility,
    SqlCompatibility,
    ExecutorCheck,
    MockCheck,
    MockRuleDescription,
    CompilationCheck,
    SourceExecutionObservation,
} from "./compatibility/index.js";
export {
    ExecutionOutcome,
    ExecutionStatus,
    ExecutionMode,
    ExecutionKind,
} from "./instrumentation/types.js";
export type {
    ExecutionReport,
    ExecutionCall,
    ExecutionChange,
    ExecutionMock,
    ExecutionFailure,
    ExecutionLocation,
    ExecutionDefinition,
    ExecutionEvent,
    ExecutionTruncation,
    ExecutionValue,
} from "./instrumentation/types.js";
export { verifyPackages, PackageIssueCode } from "./verification/index.js";
export type {
    PackageVerificationOptions,
    PackageVerificationReport,
    PackageVerificationIssue,
    PackageMethodDeclaration,
    PackageSqlDeclaration,
    PackageReference,
} from "./verification/index.js";
export type { Mock, MockInput, MockResponse, MethodMock, SqlMock } from "./mocks/types.js";
export type { Harness } from "./harness/world.js";
export type { HarnessConfig, HarnessOptions } from "./harness/configuration.js";
export type { ModuleFactory, ExecutorFactory } from "./harness/extensions.js";
export type { MethodParameters, Properties } from "./harness/world.js";
export type { Fixtures, FixtureRecord, FixtureValue } from "./fixtures/types.js";
export type { StoredItem, StorageValue } from "./storage/types.js";
export type { PlatformTraceEvent } from "./platform/trace.js";
export { PlatformError } from "./platform/errors.js";

export { fixedClock } from "./controls/clock.js";
export type { ClockSettings, ClockControl } from "./controls/clock.js";
export { seededIds } from "./controls/ids.js";
export type { IdSettings } from "./controls/ids.js";
export { FailurePoint, InjectedFailureError } from "./controls/failure-types.js";
export type {
    FailureInjection,
    InjectedFailureHandle,
    ExecutionInjection,
} from "./controls/failure-types.js";
export { ObserverError } from "./controls/observers.js";
export type { ExecutionObserver, Observation } from "./controls/observers.js";
export type { StateReader } from "./controls/state.js";
export { ItemAction } from "./platform/actions.js";
export { MethodEventDataKind } from "./methods/event-data.js";
export type {
    MethodEventData,
    BeforeUpdateEventData,
    AfterAddEventData,
    AfterUpdateEventData,
    AfterVersionEventData,
} from "./methods/event-data.js";
