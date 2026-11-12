import { spendContext } from "../../core/context.js";
import type { ExecutionContext } from "../../core/types.js";
import { Item } from "../../items/item.js";
import type {
    HarnessStorage,
    ItemTypeDefinition,
    StorageValue,
    StoredItem,
} from "../../storage/types.js";
import { ApplicationError, PlatformError } from "../errors.js";
import type { IdentityGrants } from "./grants.js";
import type { Identities } from "./identities.js";
import { SourceAccess } from "./source-access.js";
import { systemIdentity } from "./system-identities.js";
import { TeamRoles } from "./teams.js";
import { effective } from "./time.js";

export enum AccessRight {
    Get = "can_get",
    Update = "can_update",
    Delete = "can_delete",
    ChangeAccess = "can_change_access",
}

interface Actor {
    readonly user: StoredItem;
    readonly identities: ReadonlySet<string>;
    readonly teams: TeamRoles;
}

export class ItemPermissions {
    private readonly sources: SourceAccess;

    constructor(
        private readonly storage: HarnessStorage,
        private readonly identities: Identities,
        private readonly grants: IdentityGrants,
        private readonly now: () => Date,
    ) {
        this.sources = new SourceAccess(storage);
    }

    readable(
        definition: ItemTypeDefinition,
        records: readonly StoredItem[],
        context: ExecutionContext,
    ): readonly StoredItem[] {
        const actor = this.actor(context);
        this.sources.inherited(definition);

        return records.filter((record) =>
            this.allowed(definition, record, AccessRight.Get, actor, context),
        );
    }

    assert(
        definition: ItemTypeDefinition,
        record: StoredItem,
        right: AccessRight,
        context: ExecutionContext,
    ): void {
        if (!this.allowed(definition, record, right, this.actor(context), context)) {
            throw new ApplicationError(
                Item.error(
                    `Permission denied for '${definition.name}:${record.id}' (${right}).`,
                    "PermissionDenied",
                ),
            );
        }
    }

    creation(
        definition: ItemTypeDefinition,
        values: Readonly<Record<string, StorageValue>>,
        context: ExecutionContext,
    ): Readonly<Record<string, StorageValue>> {
        const actor = this.actor(context);
        this.assertSourcePolicy(definition);
        const rules = this.storage.listItems("Can Add");
        spendContext(context, rules.length);
        const permitted = rules.some(
            (record) =>
                String(record.properties.source_id).toLowerCase() === definition.id.toLowerCase() &&
                effective(record, this.now()) &&
                actor.identities.has(String(record.properties.related_id).toLowerCase()),
        );

        if (!permitted) {
            throw new ApplicationError(
                Item.error(`Cannot add '${definition.name}' for this User.`, "PermissionDenied"),
            );
        }

        const permission = values.permission_id ?? this.defaultPermission(definition, context);

        if (typeof permission !== "string" || !this.storage.getItem("Permission", permission)) {
            throw new PlatformError(
                "MissingPermission",
                `Import a default Permission for '${definition.name}'.`,
            );
        }

        this.assertSelectedPermission(definition, permission, context, values.current_state);

        return {
            permission_id: permission,
            created_by_id: actor.user.id,
            created_on: this.now().toISOString(),
        };
    }

    private actor(context: ExecutionContext): Actor {
        const identities = new Set(this.grants.current(context).map((id) => id.toLowerCase()));

        return {
            user: this.identities.user(),
            identities,
            teams: new TeamRoles(this.storage, identities, context),
        };
    }

    private allowed(
        definition: ItemTypeDefinition,
        record: StoredItem,
        right: AccessRight,
        actor: Actor,
        context: ExecutionContext,
    ): boolean {
        spendContext(context);

        const source =
            right === AccessRight.Get
                ? this.sources.resolve(definition, record, context)
                : { definition, record };
        this.assertSourcePolicy(source.definition);

        const id =
            source.record.properties.permission_id ??
            this.defaultPermission(source.definition, context);

        if (typeof id !== "string" || !this.storage.getItem("Permission", id)) {
            throw new PlatformError(
                "MissingPermission",
                `Import Permission metadata for '${source.record.type}:${source.record.id}'.`,
            );
        }

        for (const access of this.storage.listItems("Access")) {
            spendContext(context);

            if (
                String(access.properties[right] ?? "0") !== "1" ||
                String(access.properties.source_id).toLowerCase() !== id.toLowerCase() ||
                !effective(access, this.now()) ||
                !this.matches(String(access.properties.related_id), source.record, actor)
            ) {
                continue;
            }

            return true;
        }

        return false;
    }

    private matches(id: string, record: StoredItem, actor: Actor): boolean {
        if (actor.identities.has(id.toLowerCase())) {
            return true;
        }

        this.identities.byId(id);

        if (systemIdentity(id, "Creator")) {
            return (
                actor.user.id.toLowerCase() ===
                String(record.properties.created_by_id).toLowerCase()
            );
        }

        if (systemIdentity(id, "Owner")) {
            return actor.identities.has(String(record.properties.owned_by_id).toLowerCase());
        }

        if (systemIdentity(id, "Manager")) {
            return actor.identities.has(String(record.properties.managed_by_id).toLowerCase());
        }

        return actor.teams.matches(id, record);
    }

    assertIdentity(id: string, record: StoredItem, context: ExecutionContext): void {
        if (!this.matches(id, record, this.actor(context))) {
            throw new ApplicationError(
                Item.error(
                    `Identity does not permit the transition of '${record.type}'.`,
                    "PermissionDenied",
                ),
            );
        }
    }

    assertSelectedPermission(
        definition: ItemTypeDefinition,
        id: string,
        context: ExecutionContext,
        state?: StorageValue,
    ): void {
        const selected = this.storage.getItem("Permission", id);
        const lifecycle =
            typeof state === "string"
                ? this.storage.getCatalogEntry("Life Cycle State", state)
                : undefined;
        const rules = this.storage.listItems("Allowed Permission");
        spendContext(context, rules.length);
        const allowed = rules.some(
            (record) =>
                String(record.properties.source_id).toLowerCase() === definition.id.toLowerCase() &&
                String(record.properties.related_id).toLowerCase() === id.toLowerCase(),
        );
        const metadata = this.storage.getCatalogEntry("ItemType", definition.id);
        const privateAllowed =
            String(selected?.properties.is_private ?? "0") === "1" &&
            String(metadata?.properties.allow_private_permission ?? "1") === "1";

        if (
            !selected ||
            (!allowed &&
                !privateAllowed &&
                String(lifecycle?.properties.state_permission_id).toLowerCase() !==
                    id.toLowerCase())
        ) {
            throw new ApplicationError(
                Item.error(
                    `Permission '${id}' is not allowed for '${definition.name}'.`,
                    "PermissionDenied",
                ),
            );
        }
    }

    private assertSourcePolicy(definition: ItemTypeDefinition): void {
        if (this.sources.inherited(definition)) {
            throw new PlatformError(
                "UnsupportedSourceAccess",
                "Source-inherited relationship mutations require their own permission policy. Reads use the source Item's permissions.",
            );
        }
    }

    private defaultPermission(
        definition: ItemTypeDefinition,
        context: ExecutionContext,
    ): StorageValue | undefined {
        const rules = this.storage.listItems("Allowed Permission");
        spendContext(context, rules.length);
        const candidates = rules.filter(
            (record) =>
                String(record.properties.source_id).toLowerCase() === definition.id.toLowerCase() &&
                String(record.properties.is_default ?? "0") === "1",
        );

        if (candidates.length > 1) {
            throw new PlatformError(
                "AmbiguousPermission",
                `ItemType '${definition.name}' has multiple default Permissions.`,
            );
        }

        return candidates[0]?.properties.related_id;
    }
}
