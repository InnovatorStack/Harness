import type { SourceLocation } from "../diagnostics/source-location.js";
import type { PropertyDefinition } from "../storage/types.js";

/** Retained for export fidelity; these definitions require a presentation adapter to execute. */
export const presentationTypes = new Set([
    "Form",
    "Body",
    "Field",
    "View",
    "PresentationConfiguration",
    "ITPresentationConfiguration",
    "CommandBarButton",
    "CommandBarMenuButton",
    "CommandBarSection",
    "CommandBarMenu",
    "CommandBarItem",
    "CUI_Application",
    "CUI_Application_Pages",
    "cui_Location",
    "Section",
    "CommandBarSectionItem",
    "Form Event",
    "TOC View",
    "PresentationCommandBarSection",
    "Grid Event",
]);

export const systemProperties: readonly PropertyDefinition[] = [
    { name: "id", dataType: "string" },
    { name: "config_id", dataType: "item" },
    { name: "generation", dataType: "integer" },
    { name: "is_current", dataType: "boolean" },
    { name: "new_version", dataType: "boolean" },
    { name: "not_lockable", dataType: "boolean" },
    { name: "keyed_name", dataType: "string" },
    { name: "classification", dataType: "string" },
    { name: "state", dataType: "string" },
    { name: "current_state", dataType: "item" },
    { name: "created_on", dataType: "date" },
    { name: "modified_on", dataType: "date" },
    { name: "created_by_id", dataType: "item" },
    { name: "modified_by_id", dataType: "item" },
    { name: "owned_by_id", dataType: "item" },
    { name: "managed_by_id", dataType: "item" },
    { name: "permission_id", dataType: "item" },
    { name: "locked_by_id", dataType: "item" },
    { name: "is_released", dataType: "boolean" },
    { name: "major_rev", dataType: "string" },
    { name: "minor_rev", dataType: "string" },
    { name: "css", dataType: "text" },
    { name: "team_id", dataType: "item" },
];

export const versionableProperties: readonly PropertyDefinition[] = [
    { name: "effective_date", dataType: "date" },
    { name: "release_date", dataType: "date" },
    { name: "superseded_date", dataType: "date" },
];

export const relationshipProperties: readonly PropertyDefinition[] = [
    { name: "source_id", dataType: "item" },
    { name: "related_id", dataType: "item" },
    { name: "sort_order", dataType: "integer" },
    { name: "behavior", dataType: "string" },
];

export function stableId(value: string): string {
    return new Bun.CryptoHasher("sha256").update(value).digest("hex").slice(0, 32).toUpperCase();
}

export function bootstrapSource(path: string): SourceLocation {
    return { file: "<innovator-harness:bootstrap-v1>", line: 1, column: 1, path };
}
