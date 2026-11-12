import { getOwn } from "../core/data.js";

/** Stable identifiers shared by preflight reports and runtime capability errors. */
export enum CapabilityId {
    ItemActions = "item.actions",
    Queries = "item.queries",
    Relationships = "item.relationships",
    Generations = "item.generations",
    Locks = "item.locks",
    Revision = "item.revision",
    RelationshipVersioning = "item.relationship-versioning",
    FloatingReferences = "item.floating-references",
    ServerEvents = "events.version-1",
    CollectionEvents = "events.version-2",
    StateActionReplacement = "events.state-action-replacement",
    Lifecycles = "lifecycle.transitions",
    PostCommitMethods = "lifecycle.post-commit",
    NativePermissions = "security.native-permissions",
    CSharp = "methods.csharp",
    JavaScript = "methods.javascript",
    TSql = "sql.tsql",
    Workflow = "services.workflow",
    History = "services.history",
    Vault = "services.vault",
    Federation = "metadata.federation",
    Polymorphism = "metadata.polymorphism",
    DefinitionMutation = "metadata.runtime-mutation",
}

export enum CapabilitySupport {
    Supported = "SUPPORTED",
    Partial = "PARTIAL",
    Unsupported = "UNSUPPORTED",
}

export interface CapabilityDescriptor {
    readonly id: CapabilityId;
    readonly support: CapabilitySupport;
    readonly owner: string;
    readonly operations: readonly string[];
    readonly metadata: readonly string[];
    readonly dependsOn: readonly CapabilityId[];
    readonly limitations: readonly string[];
    /** Framework contract tests are implementation evidence, not native Aras comparisons. */
    readonly tests: readonly string[];
    readonly referenceVerified: boolean;
}

function descriptor(
    definition: Omit<CapabilityDescriptor, "referenceVerified">,
): CapabilityDescriptor {
    return Object.freeze({
        ...definition,
        operations: Object.freeze([...definition.operations]),
        metadata: Object.freeze([...definition.metadata]),
        dependsOn: Object.freeze([...definition.dependsOn]),
        limitations: Object.freeze([...definition.limitations]),
        tests: Object.freeze([...definition.tests]),
        referenceVerified: false,
    });
}

/** Implementation scope. Environment availability and solution requirements are reported
 * separately. */
export const capabilities: readonly CapabilityDescriptor[] = Object.freeze([
    descriptor({
        id: CapabilityId.ItemActions,
        support: CapabilitySupport.Partial,
        owner: "platform",
        operations: ["get", "add", "edit", "update", "delete"],
        metadata: ["ItemType", "Property"],
        dependsOn: [],
        limitations: [
            "Copy, clone, merge, purge and recursive platform actions are unavailable.",
            "Owned relationships and orphaned dependent Items are deleted transactionally; external references block deletion.",
        ],
        tests: [
            "tests/actions.test.ts",
            "tests/creation.test.ts",
            "tests/dependent-deletion.test.ts",
        ],
    }),
    descriptor({
        id: CapabilityId.Queries,
        support: CapabilitySupport.Partial,
        owner: "platform",
        operations: [
            "where",
            "select",
            "orderBy",
            "condition",
            "idlist",
            "page",
            "pagesize",
            "maxRecords",
        ],
        metadata: ["ItemType", "Property"],
        dependsOn: [],
        limitations: [
            "Native logical groups, repeated conditions, comparisons, sets, ranges and SQL null logic are supported.",
            "WHERE accepts property-to-literal expressions; SQL functions, subqueries and arbitrary T-SQL are unavailable.",
            "LIKE supports percent and underscore wildcards, without bracket classes or installation-specific collation.",
            "Mutation selects remain flat. Candidate, predicate, nesting and work budgets apply.",
            "Native release-specific query and paging parity remains unverified.",
        ],
        tests: [
            "tests/actions.test.ts",
            "tests/queries.test.ts",
            "tests/queries-csharp.test.ts",
            "tests/query-selection.test.ts",
        ],
    }),
    descriptor({
        id: CapabilityId.Relationships,
        support: CapabilitySupport.Partial,
        owner: "platform",
        operations: ["add", "get", "edit", "delete"],
        metadata: ["RelationshipType"],
        dependsOn: [CapabilityId.ItemActions],
        limitations: [
            "Nested reads and graph actions run through normal hooks in the parent transaction.",
            "Nested mutations require explicit child IDs. Parent versions clone current owned relationships, including versionable records.",
            "Released relationship revision/reset policies and standalone copy/clone actions remain unavailable.",
        ],
        tests: [
            "tests/actions.test.ts",
            "tests/queries-relationships.test.ts",
            "tests/versioning.test.ts",
            "tests/relationship-copy.test.ts",
        ],
    }),
    descriptor({
        id: CapabilityId.Generations,
        support: CapabilitySupport.Partial,
        owner: "platform",
        operations: ["edit", "update", "version"],
        metadata: ["ItemType"],
        dependsOn: [CapabilityId.Locks],
        limitations: [
            "Automatic/manual generations retain config_id and history.",
            "Released generations advance their imported revision sequence and restart their lifecycle; history and config_id remain stable.",
            "Versionable relationships clone as fresh configurations under a new parent; released relationship cloning remains unavailable.",
        ],
        tests: ["tests/versioning.test.ts", "tests/collection-events.test.ts"],
    }),
    descriptor({
        id: CapabilityId.Locks,
        support: CapabilitySupport.Partial,
        owner: "platform",
        operations: ["lock", "unlock"],
        metadata: ["User"],
        dependsOn: [],
        limitations: [
            "User-owned locks and implicit versionable edits are supported; ordinary locked-record mutation and some lock event paths remain unavailable.",
        ],
        tests: ["tests/versioning.test.ts"],
    }),
    descriptor({
        id: CapabilityId.Revision,
        support: CapabilitySupport.Partial,
        owner: "platform",
        operations: ["version"],
        metadata: ["Revision", "ItemType Life Cycle", "Life Cycle Map", "Life Cycle State"],
        dependsOn: [CapabilityId.Generations, CapabilityId.Lifecycles],
        limitations: [
            "Released versioning advances a declared sequence, resets state flags and release dates, and retains history and config_id.",
            "The new cycle reapplies start-state permissions and relationship behavior; native permission enforcement is separate.",
            "Sequence exhaustion is a business rejection. Minor revision policies, released relationship cloning and change-management applications remain separate work.",
            "Release-specific native revision, reset and date parity remain unverified.",
        ],
        tests: [
            "tests/revisions.test.ts",
            "tests/revision-failures.test.ts",
            "tests/revision-lifecycle.test.ts",
        ],
    }),
    descriptor({
        id: CapabilityId.RelationshipVersioning,
        support: CapabilitySupport.Partial,
        owner: "platform",
        operations: ["version"],
        metadata: ["RelationshipType"],
        dependsOn: [CapabilityId.Generations],
        limitations: [
            "Parent versioning clones current owned relationships with fresh config_id, generation one and nested owned graphs.",
            "Collection copy hooks run through normal Methods; released relationship revision/reset policies remain unavailable.",
            "Release-specific native copy contexts and configuration parity remain unverified.",
        ],
        tests: ["tests/relationship-copy.test.ts"],
    }),
    descriptor({
        id: CapabilityId.FloatingReferences,
        support: CapabilitySupport.Partial,
        owner: "platform",
        operations: ["version", "promoteItem"],
        metadata: ["Property", "RelationshipType", "Life Cycle State"],
        dependsOn: [CapabilityId.Generations],
        limitations: [
            "Imported item-property and relationship policies control floating references; historical owners retain their configuration.",
            "Lifecycle hard behavior latches until the cycle ends; hard RelationshipType behavior overrides lifecycle defaults.",
            "Unspecified relationship behavior defaults to fixed. Release-specific native parity remains unverified.",
            "Extended properties and polymorphic references require their own adapters. Released relationship cloning remains unavailable.",
        ],
        tests: ["tests/references.test.ts", "tests/dependent-deletion.test.ts"],
    }),
    descriptor({
        id: CapabilityId.ServerEvents,
        support: CapabilitySupport.Partial,
        owner: "platform",
        operations: ["before", "after", "replacement", "required"],
        metadata: ["Server Event", "Method"],
        dependsOn: [],
        limitations: [
            "Own and inherited Morphae bindings share sort_order; tied orders within the same event version are rejected.",
            "Required bindings survive serverEvents=0. Native release-specific ordering remains unverified.",
        ],
        tests: ["tests/actions.test.ts", "tests/csharp.test.ts", "tests/inherited-events.test.ts"],
    }),
    descriptor({
        id: CapabilityId.CollectionEvents,
        support: CapabilitySupport.Partial,
        owner: "platform",
        operations: [
            "onAfterAdd",
            "onAfterUpdate",
            "onAfterVersion",
            "onBeforeCopy",
            "onAfterCopy",
        ],
        metadata: ["Server Event"],
        dependsOn: [CapabilityId.ServerEvents],
        limitations: [
            "Supported after hooks run once per action collection. Separate AML actions retain separate contexts.",
            "Version-2 copy hooks receive source/result relationship collections during parent versioning; version-1 copy hooks are skipped.",
            "Before-copy hooks cannot change collection size or source identity. Other version-2 contexts fail explicitly.",
            "Release-specific native context parity remains unverified.",
        ],
        tests: ["tests/collection-events.test.ts", "tests/relationship-copy.test.ts"],
    }),
    descriptor({
        id: CapabilityId.StateActionReplacement,
        support: CapabilitySupport.Partial,
        owner: "platform",
        operations: ["onPromote", "onLock", "onUnlock"],
        metadata: ["Server Event"],
        dependsOn: [CapabilityId.ServerEvents],
        limitations: [
            "Imported replacement bindings own the request and bypass native hooks unless they explicitly delegate to the base action.",
            "CSharpInOut supports native base delegates for get/add/update/delete/lock/unlock/promote; other event-data contracts remain unavailable.",
            "The base port is invocation-scoped. Native release-specific context and locking parity remain unverified.",
        ],
        tests: ["tests/state-replacements.test.ts"],
    }),
    descriptor({
        id: CapabilityId.Lifecycles,
        support: CapabilitySupport.Partial,
        owner: "platform",
        operations: ["promoteItem"],
        metadata: [
            "Life Cycle Map",
            "Life Cycle State",
            "Life Cycle Transition",
            "ItemType Life Cycle",
        ],
        dependsOn: [CapabilityId.ServerEvents],
        limitations: [
            "Imported transitions, starting states, released revision resets and transactional pre/post Methods are supported.",
            "Native mode evaluates transition roles through imported identities and record-specific virtual roles. Workflow startup and post-commit Methods need separate services.",
        ],
        tests: ["tests/lifecycle.test.ts", "tests/revision-lifecycle.test.ts"],
    }),
    descriptor({
        id: CapabilityId.PostCommitMethods,
        support: CapabilitySupport.Unsupported,
        owner: "platform",
        operations: [],
        metadata: ["Life Cycle Transition"],
        dependsOn: [CapabilityId.Lifecycles],
        limitations: ["Transition post Methods outside the main transaction are unavailable."],
        tests: [],
    }),
    descriptor({
        id: CapabilityId.NativePermissions,
        support: CapabilitySupport.Partial,
        owner: "platform",
        operations: ["get", "add", "update", "delete", "change_access", "GrantIdentity"],
        metadata: [
            "Permission",
            "Access",
            "Allowed Permission",
            "Can Add",
            "Identity",
            "Member",
            "Alias",
            "User",
        ],
        dependsOn: [],
        limitations: [
            "Opt-in Native mode requires a User session and imported ACL, membership and creation metadata. Missing Permissions fail explicitly.",
            "Reads filter before paging; action, Method and transition checks use effective membership and scoped grants. Owner, Manager and Creator resolve per record.",
            "Team roles resolve from each Item's team_id and imported Team Identity memberships, including custom roles. Relationship reads follow source-inherited ACL chains.",
            "Can Add grants follow declared class paths and their descendants, including the root and classification defaults. Class names are case-sensitive; invalid trees fail explicitly.",
            "Source-inherited mutations remain unavailable; discovery, ABAC and MAC policies are not implemented.",
            "Release-specific native permission parity remains unverified. Callbacks and unchecked execution do not establish native ACL behavior.",
        ],
        tests: [
            "tests/security.test.ts",
            "tests/security-classification.test.ts",
            "tests/security-csharp.test.ts",
            "tests/security-isolation.test.ts",
            "tests/security-source-access.test.ts",
            "tests/security-teams.test.ts",
            "tests/reference.test.ts",
        ],
    }),
    descriptor({
        id: CapabilityId.CSharp,
        support: CapabilitySupport.Partial,
        owner: "csharp",
        operations: [
            "execute",
            "compile",
            "removeProperty",
            "SelectSingleNode",
            "SelectNodes",
            "getItemsByXPath",
            "isNew",
            "apply(action)",
            "getNewID",
            "CCO.Permissions",
            "CCO.ErrorLookup.Lookup",
            "CSharpInOut",
            "eventData.BaseLockItem",
            "eventData.BaseUnlockItem",
        ],
        metadata: ["Method"],
        dependsOn: [],
        limitations: [
            "Requires the .NET 10 SDK and configured assemblies.",
            "Only the implemented managed server API is available; compilation does not prove runtime behavior.",
            "ErrorLookup formats one imported UserMessage text; native localization, language fallback and legacy static permission APIs are unavailable.",
        ],
        tests: ["tests/csharp.test.ts", "tests/csharp-xml.test.ts"],
    }),
    descriptor({
        id: CapabilityId.JavaScript,
        support: CapabilitySupport.Unsupported,
        owner: "platform",
        operations: ["execute"],
        metadata: ["Method"],
        dependsOn: [],
        limitations: ["No built-in server JavaScript or browser Method executor."],
        tests: [],
    }),
    descriptor({
        id: CapabilityId.TSql,
        support: CapabilitySupport.Unsupported,
        owner: "platform",
        operations: ["SQL Process", "applySQL", "applySQLWithParameters"],
        metadata: ["SQL"],
        dependsOn: [],
        limitations: [
            "SQLite storage does not execute T-SQL. Explicit matching mocks can replace SQL calls.",
        ],
        tests: ["tests/mocks.test.ts"],
    }),
    descriptor({
        id: CapabilityId.Workflow,
        support: CapabilitySupport.Unsupported,
        owner: "platform",
        operations: [],
        metadata: ["Workflow Map"],
        dependsOn: [],
        limitations: ["Workflow activities, tasks and startup are unavailable."],
        tests: [],
    }),
    descriptor({
        id: CapabilityId.History,
        support: CapabilitySupport.Unsupported,
        owner: "platform",
        operations: [],
        metadata: ["History"],
        dependsOn: [],
        limitations: ["Native history services are unavailable."],
        tests: [],
    }),
    descriptor({
        id: CapabilityId.Vault,
        support: CapabilitySupport.Unsupported,
        owner: "platform",
        operations: [],
        metadata: ["File", "Vault"],
        dependsOn: [],
        limitations: ["File transfer and vault services are unavailable."],
        tests: [],
    }),
    descriptor({
        id: CapabilityId.Federation,
        support: CapabilitySupport.Unsupported,
        owner: "platform",
        operations: [],
        metadata: ["ItemType", "Property"],
        dependsOn: [],
        limitations: [
            "Federated metadata can be retained; federated storage and predicates require an adapter.",
        ],
        tests: [],
    }),
    descriptor({
        id: CapabilityId.Polymorphism,
        support: CapabilitySupport.Unsupported,
        owner: "platform",
        operations: [],
        metadata: ["ItemType", "Morphae"],
        dependsOn: [],
        limitations: [
            "Polymorphic metadata can be retained; polymorphic queries require an adapter.",
        ],
        tests: [],
    }),
    descriptor({
        id: CapabilityId.DefinitionMutation,
        support: CapabilitySupport.Unsupported,
        owner: "platform",
        operations: [],
        metadata: ["ItemType", "Property"],
        dependsOn: [],
        limitations: ["Runtime schema mutation is unavailable. Definitions load through packages."],
        tests: [],
    }),
]);

const errorCapabilities: Readonly<Record<string, CapabilityId>> = Object.freeze({
    UnsupportedAction: CapabilityId.ItemActions,
    UnsupportedReferencedDelete: CapabilityId.ItemActions,
    UnsupportedAttribute: CapabilityId.Queries,
    UnsupportedCondition: CapabilityId.Queries,
    UnsupportedWhere: CapabilityId.Queries,
    UnsupportedSelect: CapabilityId.Queries,
    UnsupportedOrder: CapabilityId.Queries,
    UnsupportedPropertyMutation: CapabilityId.Relationships,
    UnsupportedRelationships: CapabilityId.Relationships,
    UnsupportedRevision: CapabilityId.Revision,
    MissingRevisionSequence: CapabilityId.Revision,
    InvalidRevisionSequence: CapabilityId.Revision,
    UnsupportedRelationshipVersioning: CapabilityId.RelationshipVersioning,
    UnsupportedVersioningPolicy: CapabilityId.Generations,
    UnsupportedLocking: CapabilityId.Locks,
    UnsupportedEventVersion: CapabilityId.CollectionEvents,
    EventInheritanceCycle: CapabilityId.ServerEvents,
    InvalidEventInheritance: CapabilityId.ServerEvents,
    AmbiguousEventOrder: CapabilityId.ServerEvents,
    UnsupportedReplacement: CapabilityId.StateActionReplacement,
    UnsupportedPostTransactionMethod: CapabilityId.PostCommitMethods,
    UnsupportedWorkflow: CapabilityId.Workflow,
    AuthorizationRequired: CapabilityId.NativePermissions,
    MissingPermission: CapabilityId.NativePermissions,
    AmbiguousPermission: CapabilityId.NativePermissions,
    InvalidClassStructure: CapabilityId.NativePermissions,
    MissingIdentity: CapabilityId.NativePermissions,
    AmbiguousIdentity: CapabilityId.NativePermissions,
    UnsupportedSourceAccess: CapabilityId.NativePermissions,
    InvalidSourceAccess: CapabilityId.NativePermissions,
    SourceAccessCycle: CapabilityId.NativePermissions,
    MissingSourceItem: CapabilityId.NativePermissions,
    MissingTeam: CapabilityId.NativePermissions,
    InvalidTeamReference: CapabilityId.NativePermissions,
    UnsupportedTeamPermissions: CapabilityId.NativePermissions,
    CSharpUnavailable: CapabilityId.CSharp,
    CSharpBuildFailed: CapabilityId.CSharp,
    MethodCompilationFailed: CapabilityId.CSharp,
    UnsupportedMethodTemplate: CapabilityId.CSharp,
    UnsupportedEventData: CapabilityId.CSharp,
    UnsupportedSQL: CapabilityId.TSql,
    UnsupportedFederatedPredicate: CapabilityId.Federation,
    UnsupportedDefinitionMutation: CapabilityId.DefinitionMutation,
});

export function capabilityForError(code: string): CapabilityId | undefined {
    return getOwn(errorCapabilities, code);
}

export function capabilityForLanguage(language: string | undefined): CapabilityId | undefined {
    if (language?.toLowerCase() === "c#") {
        return CapabilityId.CSharp;
    }

    if (language?.toLowerCase() === "javascript") {
        return CapabilityId.JavaScript;
    }

    return undefined;
}
