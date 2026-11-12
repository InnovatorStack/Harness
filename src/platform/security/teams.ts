import { spendContext } from "../../core/context.js";
import type { ExecutionContext } from "../../core/types.js";
import type { HarnessStorage, StoredItem } from "../../storage/types.js";
import { PlatformError } from "../errors.js";
import { systemIdentity } from "./system-identities.js";

const standardRoles = ["Team", "Team Manager", "Team Member", "Team Guest"];

/** One synchronous permission check owns its membership snapshot; actions never share it. */
export class TeamRoles {
    private memberships: ReadonlyMap<string, ReadonlySet<string>> | undefined;

    constructor(
        private readonly storage: HarnessStorage,
        private readonly identities: ReadonlySet<string>,
        private readonly context: ExecutionContext,
    ) {}

    matches(roleId: string, record: StoredItem): boolean {
        if (!this.isRole(roleId)) {
            return false;
        }

        const teamId = this.teamId(record);

        if (!teamId) {
            return false;
        }

        const roles = this.memberRoles().get(teamId.toLowerCase());

        // The standard Team Identity represents membership in any role, including no role.
        return Boolean(
            roles && (systemIdentity(roleId, "Team") || roles.has(roleId.toLowerCase())),
        );
    }

    private isRole(id: string): boolean {
        if (standardRoles.some((name) => systemIdentity(id, name))) {
            return true;
        }

        const identity = this.storage.getItem("Identity", id);

        return String(identity?.properties.classification ?? "").toLowerCase() === "team";
    }

    private teamId(record: StoredItem): string | undefined {
        const id = record.properties.team_id;

        if (id === undefined || id === null || id === "") {
            return undefined;
        }

        const source = this.storage.getItemType(record.type)?.source;

        if (typeof id !== "string") {
            throw new PlatformError(
                "InvalidTeamReference",
                `Item '${record.type}:${record.id}' requires a Team ID in team_id.`,
                source ? { source } : undefined,
            );
        }

        if (!this.storage.getItem("Team", id)) {
            throw new PlatformError(
                "MissingTeam",
                `Import Team '${id}' before checking roles on '${record.type}:${record.id}'.`,
                source ? { source } : undefined,
            );
        }

        return id;
    }

    private memberRoles(): ReadonlyMap<string, ReadonlySet<string>> {
        if (this.memberships) {
            return this.memberships;
        }

        const memberships = new Map<string, Set<string>>();

        for (const member of this.storage.listItems("Team Identity")) {
            spendContext(this.context);

            if (!this.identities.has(String(member.properties.related_id).toLowerCase())) {
                continue;
            }

            const teamId = String(member.properties.source_id).toLowerCase();
            const roles = memberships.get(teamId) ?? new Set<string>();
            roles.add(String(member.properties.team_role ?? "").toLowerCase());
            memberships.set(teamId, roles);
        }

        this.memberships = memberships;

        return memberships;
    }
}
