import { assertActiveContext } from "../../core/context.js";
import { requestOperationsMax } from "../../core/limits.js";
import type { ExecutionContext } from "../../core/types.js";
import type { MethodSecurity } from "../../methods/types.js";
import { PlatformError } from "../errors.js";
import type { PlatformTrace } from "../trace.js";
import type { Identities } from "./identities.js";

export class IdentityGrants {
    private readonly requests = new Map<string, Map<symbol, string>>();

    constructor(
        private readonly identities: Identities,
        private readonly trace: PlatformTrace,
    ) {}

    current(context: ExecutionContext): readonly string[] {
        assertActiveContext(context);
        const grants = this.requests.get(context.requestId);

        return this.identities.current(grants?.values() ?? [], context);
    }

    scope(context: ExecutionContext): MethodSecurity & Disposable {
        const owned = new Set<Disposable>();
        let closed = false;
        let issued = 0;
        const active = () => {
            assertActiveContext(context);

            if (closed) {
                throw new PlatformError(
                    "ExpiredSecurityScope",
                    "The Method identity scope has completed.",
                );
            }
        };

        return {
            getIdentities: () => {
                active();

                return this.current(context);
            },

            getIdentityByName: (name) => {
                active();

                return this.identities.byName(name, context);
            },

            grantIdentity: (id) => {
                active();

                if (++issued > requestOperationsMax) {
                    throw new PlatformError(
                        "ProtocolLimit",
                        "Identity grants exceed their invocation budget.",
                    );
                }

                const grant = this.grant(id, context);
                owned.add(grant);

                return grant;
            },

            [Symbol.dispose]: () => {
                closed = true;

                for (const grant of owned) {
                    grant[Symbol.dispose]();
                }

                owned.clear();
            },
        };
    }

    private grant(id: string, context: ExecutionContext): Disposable {
        this.identities.user();
        const identity = this.identities.byId(id);
        const grants = this.requests.get(context.requestId) ?? new Map<symbol, string>();

        if (grants.size >= requestOperationsMax) {
            throw new PlatformError(
                "ProtocolLimit",
                "Identity grants exceed their request budget.",
            );
        }

        const token = Symbol(identity.id);
        grants.set(token, identity.id);
        this.requests.set(context.requestId, grants);
        this.trace.record(context, {
            kind: "authorization",
            name: `Grant Identity '${identity.name}'`,
        });
        let active = true;

        return {
            [Symbol.dispose]: () => {
                if (!active) {
                    return;
                }

                active = false;
                grants.delete(token);

                if (grants.size === 0 && this.requests.get(context.requestId) === grants) {
                    this.requests.delete(context.requestId);
                }
            },
        };
    }
}
