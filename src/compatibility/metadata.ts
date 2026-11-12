import { dataNodesMax } from "../core/limits.js";
import type { HarnessConfig } from "../harness/configuration.js";
import { PlatformError } from "../platform/errors.js";
import { EventBindings } from "../platform/events/bindings.js";
import { ServerEventVersion } from "../platform/events/types.js";
import { eventVersion } from "../platform/events/version.js";
import type { CatalogEntry, HarnessStorage } from "../storage/types.js";
import { CapabilityId, capabilityForError } from "./capabilities.js";
import { inspectRevisions } from "./revisions.js";
import { inspectSecurity } from "./security.js";
import { CompatibilityIssueCode, IssueSeverity } from "./types.js";
import type { CompatibilityIssue } from "./types.js";

/** Metadata requirements only: presence identifies a boundary, not proof it will be exercised. */
export function inspectMetadata(
    storage: HarnessStorage,
    files: ReadonlySet<string>,
    settings: HarnessConfig,
): readonly CompatibilityIssue[] {
    const issues: CompatibilityIssue[] = [];
    const entries = storage.listCatalogEntries().filter((entry) => files.has(entry.source.file));
    const eventOrder = new Map<string, CatalogEntry>();

    for (const entry of entries) {
        const properties = entry.properties;
        const type = entry.type.toLowerCase();
        inspectServerEvent(entry, eventOrder, issues);

        if (
            type === "life cycle transition" &&
            Boolean(properties.post_action) &&
            String(properties.execute_post_in_main_txn ?? "0") !== "1"
        ) {
            unsupported(
                issues,
                entry,
                "UnsupportedPostTransactionMethod",
                "This transition runs a post Method outside the main transaction, which is unavailable.",
            );
        }

        if (type === "life cycle state" && Boolean(properties.workflow)) {
            unsupported(
                issues,
                entry,
                "UnsupportedWorkflow",
                `State '${properties.name}' starts a workflow, which requires an adapter.`,
            );
        }

        inspectItemType(entry, issues);
        const restrictedMethod = type === "method" && Boolean(properties.execution_allowed_to);
        const restrictedTransition = type === "life cycle transition" && Boolean(properties.role);

        if ((restrictedMethod || restrictedTransition) && settings.authorization === undefined) {
            issues.push(
                Object.freeze({
                    code: CompatibilityIssueCode.AuthorizationRequired,
                    severity: IssueSeverity.Warning,
                    capability: CapabilityId.NativePermissions,
                    causeCode: "AuthorizationRequired",
                    message: `Restricted ${entry.type} '${properties.name ?? entry.id}' requires an explicit authorization policy or unchecked execution.`,
                    source: entry.source,
                }),
            );
        }
    }

    inspectInheritedEvents(storage, entries, issues);

    return [
        ...issues,
        ...inspectRevisions(storage, files),
        ...inspectSecurity(entries, settings.authorization),
    ];
}

function inspectServerEvent(
    entry: CatalogEntry,
    eventOrder: Map<string, CatalogEntry>,
    issues: CompatibilityIssue[],
): void {
    const properties = entry.properties;
    const type = entry.type.toLowerCase();

    if (type === "server event") {
        const name = String(properties.server_event ?? "");
        const version = String(properties.event_version ?? "version_1");

        if (name.toLowerCase() === "onafterresetlifecycle") {
            unsupported(
                issues,
                entry,
                "UnsupportedLifecycleResetEvent",
                "Lifecycle reset callbacks require native reset event metadata, which is unavailable.",
            );
        }

        try {
            eventVersion(name, properties.event_version, entry.source);
        } catch (error) {
            if (!(error instanceof PlatformError)) {
                throw error;
            }

            unsupported(issues, entry, error.code, error.message);
        }

        const owner = String(properties.source_id).toLowerCase();
        const order = Number(properties.sort_order ?? 0);
        const key = `${owner}:${name.toLowerCase()}:${version}:${order}`;

        if (eventOrder.has(key)) {
            unsupported(
                issues,
                entry,
                "AmbiguousEventOrder",
                `Events for '${name}' share sort_order '${properties.sort_order ?? 0}'; runtime rejects tied ordering.`,
            );
        } else {
            eventOrder.set(key, entry);
        }
    }
}

function inspectItemType(entry: CatalogEntry, issues: CompatibilityIssue[]): void {
    const properties = entry.properties;
    const type = entry.type.toLowerCase();

    if (type === "itemtype") {
        const implementation = properties.implementation_type;

        if (Boolean(implementation) && implementation !== "table") {
            const capability =
                String(implementation).toLowerCase() === "polymorphic"
                    ? CapabilityId.Polymorphism
                    : CapabilityId.Federation;
            unsupported(
                issues,
                entry,
                "UnsupportedImplementation",
                `ItemType '${properties.name}' uses '${implementation}' storage; its metadata can import but runtime queries require an adapter.`,
                capability,
            );
        }
    }
}

function unsupported(
    issues: CompatibilityIssue[],
    entry: CatalogEntry,
    causeCode: string,
    message: string,
    capability = capabilityForError(causeCode),
): void {
    issues.push(
        Object.freeze({
            code: CompatibilityIssueCode.UnsupportedCapability,
            severity: IssueSeverity.Warning,
            causeCode,
            message,
            source: entry.source,
            ...(capability !== undefined ? { capability } : {}),
        }),
    );
}

function inspectInheritedEvents(
    storage: HarnessStorage,
    entries: readonly CatalogEntry[],
    issues: CompatibilityIssue[],
): void {
    const bindings = new EventBindings(storage);
    const related = new Set(
        storage
            .listCatalogEntries("Morphae")
            .map((entry) => String(entry.properties.related_id).toLowerCase()),
    );
    const types = storage.listItemTypes().filter((type) => related.has(type.id.toLowerCase()));
    const names = new Set(
        entries
            .filter((entry) => entry.type === "Server Event")
            .map((entry) => String(entry.properties.server_event)),
    );

    if (types.length * names.size > dataNodesMax) {
        throw new PlatformError(
            "ProtocolLimit",
            "Inherited event inspection exceeds its work budget.",
        );
    }

    for (const type of types) {
        for (const name of names) {
            for (const version of Object.values(ServerEventVersion)) {
                try {
                    bindings.select(type, name, true, version);
                } catch (error) {
                    if (!(error instanceof PlatformError)) {
                        throw error;
                    }

                    issues.push(
                        Object.freeze({
                            code: CompatibilityIssueCode.UnsupportedCapability,
                            severity: IssueSeverity.Warning,
                            causeCode: error.code,
                            message: error.message,
                            ...(error.capability !== undefined
                                ? { capability: error.capability }
                                : {}),
                            ...(error.source ? { source: error.source } : {}),
                        }),
                    );
                }
            }
        }
    }
}
