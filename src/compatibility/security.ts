import { systemIdentity } from "../platform/security/system-identities.js";
import { AuthorizationMode } from "../platform/security/types.js";
import type { AuthorizationPolicy } from "../platform/security/types.js";
import type { CatalogEntry } from "../storage/types.js";
import { CapabilityId } from "./capabilities.js";
import { CompatibilityIssueCode, IssueSeverity } from "./types.js";
import type { CompatibilityIssue } from "./types.js";

/** Report known metadata gaps without pretending to evaluate unexercised business paths. */
export function inspectSecurity(
    entries: readonly CatalogEntry[],
    authorization: AuthorizationPolicy | undefined,
): readonly CompatibilityIssue[] {
    if (authorization === AuthorizationMode.Unchecked) {
        return [
            Object.freeze({
                code: CompatibilityIssueCode.UnsupportedCapability,
                severity: IssueSeverity.Information,
                capability: CapabilityId.NativePermissions,
                message:
                    "Authorization is explicitly unchecked; these tests do not validate native permission rules.",
            }),
        ];
    }

    if (authorization !== AuthorizationMode.Native) {
        return [];
    }

    const issues: CompatibilityIssue[] = [];

    for (const entry of entries) {
        const sourceAccess =
            entry.type === "ItemType" && String(entry.properties.use_src_access) === "1";
        const teamAccess =
            entry.type === "Access" &&
            ["Team", "Team Guest", "Team Manager", "Team Member"].some((name) =>
                systemIdentity(String(entry.properties.related_id), name),
            );

        if (sourceAccess || teamAccess) {
            issues.push(
                Object.freeze({
                    code: CompatibilityIssueCode.UnsupportedCapability,
                    severity: IssueSeverity.Warning,
                    capability: CapabilityId.NativePermissions,
                    causeCode: sourceAccess
                        ? "UnsupportedSourceAccess"
                        : "UnsupportedTeamPermissions",
                    message: sourceAccess
                        ? `ItemType '${entry.properties.name}' requires source-inherited access.`
                        : "This Access row requires team-role identity resolution.",
                    source: entry.source,
                }),
            );
        }
    }

    return issues;
}
