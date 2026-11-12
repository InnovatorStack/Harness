import { requestOperationsMax } from "../../core/limits.js";
import { object } from "../../items/codec.js";
import { Item } from "../../items/item.js";
import { PlatformError } from "../../platform/errors.js";
import type { MethodPorts } from "../types.js";

const operations = new Set([
    "securityIdentities",
    "securityIdentity",
    "securityGrant",
    "securityRevoke",
]);

/** Tokens belong to one managed invocation; they never consume business Item identities. */
export class ManagedSecurity implements Disposable {
    private readonly grants = new Map<string, Disposable>();
    private nextToken = 0;
    private closed = false;

    handles(operation: unknown): boolean {
        return typeof operation === "string" && operations.has(operation);
    }

    invoke(operation: unknown, payload: unknown, ports: MethodPorts): Item {
        const security = ports.security;

        if (this.closed) {
            throw new PlatformError(
                "ExpiredSecurityScope",
                "The managed security scope has completed.",
            );
        }

        if (!security) {
            return ports.fail("The Method executor has no native security port.");
        }

        if (operation === "securityIdentities") {
            return new Item({ items: [], result: security.getIdentities().join(",") });
        }

        if (!object(payload)) {
            throw new PlatformError(
                "InvalidProtocol",
                "Native security requests need an object payload.",
            );
        }

        if (operation === "securityIdentity" && typeof payload.name === "string") {
            const identity = security.getIdentityByName(payload.name);

            if (!identity) {
                return new Item({ items: [] });
            }

            const item = Item.create("Identity");
            item.setProperty("id", identity.id);
            item.setProperty("name", identity.name);

            return item;
        }

        if (operation === "securityGrant" && typeof payload.id === "string") {
            if (this.nextToken >= requestOperationsMax) {
                throw new PlatformError(
                    "ProtocolLimit",
                    "Managed identity grants exceed their invocation budget.",
                );
            }

            const token = String(++this.nextToken);
            this.grants.set(token, security.grantIdentity(payload.id));

            return new Item({ items: [], result: token });
        }

        if (operation === "securityRevoke" && typeof payload.token === "string") {
            return this.revoke(payload.token);
        }

        throw new PlatformError("InvalidProtocol", "Unknown or malformed native security request.");
    }

    [Symbol.dispose](): void {
        this.closed = true;
        const failures: unknown[] = [];

        for (const grant of this.grants.values()) {
            try {
                grant[Symbol.dispose]();
            } catch (error) {
                failures.push(error);
            }
        }

        this.grants.clear();

        if (failures.length > 0) {
            throw new AggregateError(
                failures,
                "Managed identity grants could not all be disposed.",
            );
        }
    }

    private revoke(token: string): Item {
        const grant = this.grants.get(token);

        if (!grant) {
            throw new PlatformError(
                "InvalidSecurityGrant",
                "The identity grant does not belong to this invocation.",
            );
        }

        grant[Symbol.dispose]();
        this.grants.delete(token);

        return new Item({ items: [] });
    }
}
