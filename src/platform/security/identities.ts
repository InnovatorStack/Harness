import { spendContext } from "../../core/context.js";
import { dataNodesMax } from "../../core/limits.js";
import type { ExecutionContext } from "../../core/types.js";
import type { MethodIdentity } from "../../methods/types.js";
import type { HarnessStorage, StoredItem } from "../../storage/types.js";
import { PlatformError } from "../errors.js";
import { systemIdentityId } from "./system-identities.js";
import { effective } from "./time.js";

export class Identities {
    constructor(
        private readonly storage: HarnessStorage,
        private readonly userId: (() => string) | undefined,
        private readonly now: () => Date,
    ) {}

    user(): StoredItem {
        const id = this.userId?.();
        const user = id ? this.storage.getItem("User", id) : undefined;

        if (!user) {
            throw new PlatformError(
                "SessionRequired",
                "Native identity checks require an imported User session.",
            );
        }

        return user;
    }

    byName(name: string, context: ExecutionContext): MethodIdentity | undefined {
        const identities = this.storage.listItems("Identity");
        spendContext(context, identities.length);
        const records = identities.filter(
            (record) => String(record.properties.name).toLowerCase() === name.toLowerCase(),
        );

        if (records.length > 1) {
            throw new PlatformError("AmbiguousIdentity", `Identity '${name}' is not unique.`);
        }

        const record = records[0];

        return record ? this.describe(record) : undefined;
    }

    byId(id: string): MethodIdentity {
        const record = this.storage.getItem("Identity", id);

        if (!record) {
            throw new PlatformError("MissingIdentity", `Import Identity '${id}' before using it.`);
        }

        return this.describe(record);
    }

    current(granted: Iterable<string>, context: ExecutionContext): readonly string[] {
        const user = this.user();
        const worldId = systemIdentityId("World");
        const world = worldId ? this.byId(worldId) : undefined;

        if (!world) {
            throw new PlatformError("MissingIdentity", "The World Identity is required.");
        }

        const ids = new Map<string, string>([[world.id.toLowerCase(), world.id]]);

        for (const alias of this.storage.listItems("Alias")) {
            spendContext(context);

            if (String(alias.properties.source_id).toLowerCase() === user.id.toLowerCase()) {
                const identity = this.byId(String(alias.properties.related_id));
                ids.set(identity.id.toLowerCase(), identity.id);
            }
        }

        for (const id of granted) {
            const identity = this.byId(id);
            ids.set(identity.id.toLowerCase(), identity.id);
        }

        return this.expand(ids, context);
    }

    private expand(ids: Map<string, string>, context: ExecutionContext): readonly string[] {
        const parents = new Map<string, string[]>();

        for (const member of this.storage.listItems("Member")) {
            spendContext(context);

            if (effective(member, this.now())) {
                const child = String(member.properties.related_id).toLowerCase();
                const values = parents.get(child) ?? [];
                values.push(String(member.properties.source_id));
                parents.set(child, values);
            }
        }

        const pending = [...ids.values()];
        let visited = 0;

        while (pending.length > 0) {
            const id = pending.pop();

            if (!id || ++visited > dataNodesMax) {
                throw new PlatformError(
                    "ProtocolLimit",
                    "Identity membership exceeds its graph budget.",
                );
            }

            for (const parent of parents.get(id.toLowerCase()) ?? []) {
                spendContext(context);
                const identity = this.byId(parent);
                const key = identity.id.toLowerCase();

                if (!ids.has(key)) {
                    ids.set(key, identity.id);
                    pending.push(identity.id);
                }
            }
        }

        return [...ids.values()].sort((left, right) => left.localeCompare(right));
    }

    private describe(record: StoredItem): MethodIdentity {
        const name = record.properties.name;

        if (typeof name !== "string" || name.length === 0) {
            throw new PlatformError("InvalidIdentity", `Identity '${record.id}' needs a name.`);
        }

        return Object.freeze({ id: record.id, name });
    }
}
