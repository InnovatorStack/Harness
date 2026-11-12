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
import { recordKey } from "../references/catalog.js";
import type { PlatformTrace } from "../trace.js";
import { IdentityGrants } from "./grants.js";
import { Identities } from "./identities.js";
import { AccessRight, ItemPermissions } from "./permissions.js";
import { SourceAccess } from "./source-access.js";
import { SourceInheritance } from "./source-inheritance.js";
import { AuthorizationMode } from "./types.js";
import type { AuthorizationPolicy, AuthorizationRequest } from "./types.js";

interface OwnedDeletion {
    readonly recordKey: string;
}

export class NativeSecurity {
    readonly grants: IdentityGrants;
    readonly permissions: ItemPermissions;
    private readonly identities: Identities;
    private readonly inheritance: SourceInheritance;
    private readonly sources: SourceAccess;
    private readonly ownedDeletes = new Map<string, OwnedDeletion>();

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
        this.sources = new SourceAccess(storage);
        this.inheritance = new SourceInheritance(storage, this.sources, trace, this.permissions);
    }

    get enabled(): boolean {
        return this.mode === AuthorizationMode.Native;
    }

    reset(): void {
        this.ownedDeletes.clear();
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
        if (records.length > 0 && records.every((record) => this.ownsDeletion(record, context))) {
            return records;
        }

        return this.enabled ? this.permissions.readable(definition, records, context) : records;
    }

    assertMutation(
        definition: ItemTypeDefinition,
        record: StoredItem,
        action: string,
        context: ExecutionContext,
    ): void {
        // Unlock checks persisted lock ownership, including after an ACL or state change.
        if (
            !this.enabled ||
            action === "unlock" ||
            (action === "delete" && this.ownsDeletion(record, context))
        ) {
            return;
        }

        const right = action === "delete" ? AccessRight.Delete : AccessRight.Update;
        this.permissions.assert(definition, record, right, context);
    }

    async deletingOwned(
        record: StoredItem,
        context: ExecutionContext,
        apply: () => Promise<Item>,
    ): Promise<Item> {
        assertActiveContext(context);
        const scope = { recordKey: recordKey(record) };
        this.ownedDeletes.set(context.executionId, scope);

        try {
            return await apply();
        } finally {
            if (this.ownedDeletes.get(context.executionId) === scope) {
                this.ownedDeletes.delete(context.executionId);
            }
        }
    }

    private ownsDeletion(record: StoredItem, context: ExecutionContext): boolean {
        return (
            this.ownedDeletes.get(context.parentExecutionId ?? "")?.recordKey === recordKey(record)
        );
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
            changes.source_id !== undefined &&
            String(changes.source_id).toLowerCase() !==
                String(record.properties.source_id).toLowerCase() &&
            this.sources.inherited(definition)
        ) {
            throw new PlatformError(
                "UnsupportedSourceAccessMove",
                "Moving an inherited relationship to another source requires its own permission policy.",
                definition.source ? { source: definition.source } : undefined,
            );
        }

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

    changed(before: StoredItem, after: StoredItem, context: ExecutionContext): void {
        if (this.enabled) {
            this.inheritance.changed(before, after, context);
        }
    }

    copied(
        definition: ItemTypeDefinition,
        values: Readonly<Record<string, StorageValue>>,
        context: ExecutionContext,
    ): Readonly<Record<string, StorageValue>> {
        if (!this.enabled || !this.sources.inherited(definition)) {
            return {};
        }

        const source = this.sources.owner(definition, values, context);

        return this.permissions.sourceProperties(source.definition, source.record, context);
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
