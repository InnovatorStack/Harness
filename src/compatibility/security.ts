import { PlatformError } from "../platform/errors.js";
import { sourceAccessEnabled } from "../platform/security/source-access.js";
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
        const sourceAccess = inspectSourceAccess(entry);

        if (sourceAccess) {
            issues.push(sourceAccess);
        }

        const teamAccess =
            entry.type === "Access" &&
            ["Team", "Team Guest", "Team Manager", "Team Member"].some((name) =>
                systemIdentity(String(entry.properties.related_id), name),
            );

        if (teamAccess) {
            issues.push(
                Object.freeze({
                    code: CompatibilityIssueCode.UnsupportedCapability,
                    severity: IssueSeverity.Warning,
                    capability: CapabilityId.NativePermissions,
                    causeCode: "UnsupportedTeamPermissions",
                    message: "This Access row requires team-role identity resolution.",
                    source: entry.source,
                }),
            );
        }
    }

    return issues;
}

function inspectSourceAccess(entry: CatalogEntry): CompatibilityIssue | undefined {
    if (entry.type !== "ItemType") {
        return undefined;
    }

    try {
        const enabled = sourceAccessEnabled(
            {
                name: String(entry.properties.name),
                isRelationship: String(entry.properties.is_relationship) === "1",
                source: entry.source,
            },
            entry.properties.use_src_access,
        );

        if (!enabled) {
            return undefined;
        }
    } catch (error) {
        if (!(error instanceof PlatformError)) {
            throw error;
        }

        const invalid = error.code === "InvalidSourceAccess";

        return Object.freeze({
            code: invalid
                ? CompatibilityIssueCode.InvalidDefinition
                : CompatibilityIssueCode.UnsupportedCapability,
            severity: invalid ? IssueSeverity.Error : IssueSeverity.Warning,
            capability: CapabilityId.NativePermissions,
            causeCode: error.code,
            message: error.message,
            source: entry.source,
        });
    }

    return Object.freeze({
        code: CompatibilityIssueCode.UnsupportedCapability,
        severity: IssueSeverity.Warning,
        capability: CapabilityId.NativePermissions,
        causeCode: "UnsupportedSourceAccess",
        message: `ItemType '${entry.properties.name}' uses source-inherited access. Relationship reads resolve its source ACL; direct mutations remain unavailable.`,
        source: entry.source,
    });
}
