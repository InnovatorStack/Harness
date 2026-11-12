import { spendContext } from "../../core/context.js";
import { dataNodesMax } from "../../core/limits.js";
import type { ExecutionContext } from "../../core/types.js";
import { Item } from "../../items/item.js";
import type { HarnessStorage, StoredItem } from "../../storage/types.js";
import { ApplicationError, PlatformError } from "../errors.js";
import { recordKey } from "./catalog.js";
import type { ReferenceCatalog } from "./catalog.js";

interface ReferenceSession {
    readonly created: Map<string, StoredItem>;
    readonly scheduled: Set<string>;
    readonly active: Set<string>;
    readonly deleted: Map<string, StoredItem>;
}

/** A Method or AML batch may construct several linked Items before the transaction is checked. */
export class ReferenceSessions {
    private readonly sessions = new Map<string, ReferenceSession>();

    constructor(
        private readonly storage: HarnessStorage,
        private readonly catalog: ReferenceCatalog,
    ) {}

    async run<T>(context: ExecutionContext, work: () => Promise<T>): Promise<T> {
        if (this.sessions.has(context.requestId)) {
            return await work();
        }

        const session: ReferenceSession = {
            created: new Map(),
            scheduled: new Set(),
            active: new Set(),
            deleted: new Map(),
        };
        this.sessions.set(context.requestId, session);

        try {
            const result = await work();
            this.validate(session, context);

            return result;
        } finally {
            this.sessions.delete(context.requestId);
        }
    }

    created(record: StoredItem, context: ExecutionContext): void {
        this.session(context).created.set(recordKey(record), record);
    }

    schedule(record: StoredItem, context: ExecutionContext): void {
        const session = this.session(context);

        if (session.scheduled.size >= dataNodesMax) {
            throw new PlatformError("ProtocolLimit", "Deletion exceeds its record budget.");
        }

        session.scheduled.add(recordKey(record));
    }

    scheduled(record: StoredItem, context: ExecutionContext): boolean {
        return this.session(context).scheduled.has(recordKey(record));
    }

    active(record: StoredItem, context: ExecutionContext): boolean {
        return this.session(context).active.has(recordKey(record));
    }

    async deleting<T>(
        record: StoredItem,
        context: ExecutionContext,
        work: () => Promise<T>,
    ): Promise<T> {
        const session = this.session(context);
        const key = recordKey(record);

        if (session.active.has(key)) {
            throw new PlatformError(
                "RelationshipCycle",
                `Cyclic deletion of '${record.type}:${record.id}'.`,
            );
        }

        session.active.add(key);

        try {
            return await work();
        } finally {
            session.active.delete(key);
        }
    }

    deleted(record: StoredItem, context: ExecutionContext): void {
        this.session(context).deleted.set(recordKey(record), record);
    }

    private session(context: ExecutionContext): ReferenceSession {
        spendContext(context);
        const session = this.sessions.get(context.requestId);

        if (!session) {
            throw new Error("Platform reference changes require an active request scope.");
        }

        return session;
    }

    private validate(session: ReferenceSession, context: ExecutionContext): void {
        for (const record of session.deleted.values()) {
            if (this.storage.getItem(record.type, record.id)) {
                continue;
            }

            const incoming = this.catalog.incoming(record, context).next();

            if (!incoming.done) {
                const source = incoming.value;

                throw new ApplicationError(
                    Item.error(
                        `Deletion left '${source.definition.name}.${source.property.name}' referencing '${record.type}:${record.id}'.`,
                        "ReferencedItem",
                    ),
                );
            }
        }

        for (const record of session.created.values()) {
            const definition = this.storage.getItemType(record.type);

            if (
                definition &&
                this.catalog.dependent(definition) &&
                this.storage.getItem(record.type, record.id) &&
                !this.catalog.hasOwner(record, context)
            ) {
                throw new ApplicationError(
                    Item.error(
                        `Dependent '${record.type}:${record.id}' requires an owning reference in the same request.`,
                        "DependentItem",
                    ),
                );
            }
        }
    }
}
