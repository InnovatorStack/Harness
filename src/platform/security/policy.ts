import { assertActiveContext } from "../../core/context.js";
import type { ExecutionContext } from "../../core/types.js";
import { Item } from "../../items/item.js";
import type {
    HarnessStorage,
    CatalogEntry,
    ItemTypeDefinition,
    StorageValue,
    StoredItem,
} from "../../storage/types.js";
import { ApplicationError, PlatformError } from "../errors.js";
import type { PlatformTrace } from "../trace.js";
import { IdentityGrants } from "./grants.js";
import { Identities } from "./identities.js";
import { AccessRight, ItemPermissions } from "./permissions.js";
import { AuthorizationMode } from "./types.js";
import type { AuthorizationPolicy, AuthorizationRequest } from "./types.js";

export class NativeSecurity {
    readonly grants: IdentityGrants;
    readonly permissions: ItemPermissions;
    private readonly identities: Identities;

    constructor(
        private readonly storage: HarnessStorage,
        private readonly mode: AuthorizationPolicy | undefined,
        userId: (() => string) | undefined,
        private readonly now: () => Date,
        trace: PlatformTrace,
    ) {
        this.identities = new Identities(storage, userId, now);
        this.grants = new IdentityGrants(this.identities, trace);
        this.permissions = new ItemPermissions(storage, this.identities, this.grants, now);
    }

    get enabled(): boolean {
        return this.mode === AuthorizationMode.Native;
    }

    authorize(request: AuthorizationRequest, context: ExecutionContext): void {
        assertActiveContext(context);
        this.identities.user();

        if (request.kind === "action") {
            return;
        }

        let identity: StorageValue | undefined;

        if (request.kind === "method") {
            const method = this.storage
                .listCatalogEntries("Method")
                .find(
                    (entry) =>
                        String(entry.properties.name).toLowerCase() === request.name.toLowerCase(),
                );
            identity = method?.properties.execution_allowed_to;
        } else {
            identity = this.storage.getCatalogEntry("Life Cycle Transition", request.name)
                ?.properties.role;
        }

        if (
            identity !== undefined &&
            identity !== null &&
            identity !== "" &&
            !this.grants
                .current(context)
                .some((id) => id.toLowerCase() === String(identity).toLowerCase())
        ) {
            throw new ApplicationError(
                Item.error(`Identity does not permit '${request.name}'.`, "PermissionDenied"),
            );
        }
    }

    readable(
        definition: ItemTypeDefinition,
        records: readonly StoredItem[],
        context: ExecutionContext,
    ) {
        return this.enabled ? this.permissions.readable(definition, records, context) : records;
    }

    assertMutation(
        definition: ItemTypeDefinition,
        record: StoredItem,
        action: string,
        context: ExecutionContext,
    ): void {
        // Unlock checks persisted lock ownership, including after an ACL or state change.
        if (!this.enabled || action === "unlock") {
            return;
        }

        const right = action === "delete" ? AccessRight.Delete : AccessRight.Update;
        this.permissions.assert(definition, record, right, context);
    }

    creation(
        definition: ItemTypeDefinition,
        values: Readonly<Record<string, StorageValue>>,
        context: ExecutionContext,
    ) {
        return this.enabled ? this.permissions.creation(definition, values, context) : {};
    }

    assertAccessChange(
        definition: ItemTypeDefinition,
        record: StoredItem,
        changes: Readonly<Record<string, StorageValue>>,
        context: ExecutionContext,
    ): void {
        if (
            this.enabled &&
            changes.permission_id !== undefined &&
            String(changes.permission_id).toLowerCase() !==
                String(record.properties.permission_id).toLowerCase()
        ) {
            this.permissions.assert(definition, record, AccessRight.ChangeAccess, context);
            this.permissions.assertSelectedPermission(
                definition,
                String(changes.permission_id),
                context,
                record.properties.current_state,
            );
        }
    }

    transition(transition: CatalogEntry, record: StoredItem, context: ExecutionContext): void {
        const role = transition.properties.role;

        if (role !== undefined && role !== null && role !== "") {
            this.permissions.assertIdentity(String(role), record, context);
        }
    }

    auditedChanges(
        record: StoredItem,
        changes: Record<string, StorageValue>,
    ): Record<string, StorageValue> {
        if (!this.enabled) {
            return changes;
        }

        for (const property of ["created_by_id", "created_on"]) {
            if (
                changes[property] !== undefined &&
                changes[property] !== record.properties[property]
            ) {
                throw new PlatformError(
                    "ManagedProperty",
                    `Cannot change '${property}' on an existing Item.`,
                );
            }
        }

        return {
            ...changes,
            modified_by_id: this.identities.user().id,
            modified_on: this.now().toISOString(),
        };
    }
}
