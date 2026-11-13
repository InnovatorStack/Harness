import { assertDataTree } from "../../core/data.js";
import { dataNodesMax } from "../../core/limits.js";
import { decodePayload, object } from "../../items/codec.js";
import type { ItemPayload } from "../../items/item.js";
import { bindItemOrigin, itemNodes, itemOrigin } from "../../items/origins.js";
import { PlatformError } from "../../platform/errors.js";

export interface OriginFrame {
    readonly scope: string;
    readonly tokens: readonly string[];
}

/** Tokens are local to one managed invocation; opaque Item origins survive ordinary clones. */
export class ManagedOrigins {
    private readonly scope = crypto.randomUUID();
    private readonly tokens = new Map<symbol, string>();
    private readonly origins = new Map<string, symbol>();
    private nextToken = 0;

    capture(payload: ItemPayload): OriginFrame {
        assertDataTree(payload);
        const result: string[] = [];
        const used = new Set<symbol>();

        for (const node of itemNodes(payload)) {
            const origin = itemOrigin(node) ?? Symbol("pending Item");

            if (used.has(origin)) {
                throw new PlatformError("InvalidProtocol", "An Item origin occurs more than once.");
            }

            used.add(origin);
            bindItemOrigin(node, origin);
            let token = this.tokens.get(origin);

            if (token === undefined) {
                token = `b${++this.nextToken}`;
                this.remember(token, origin);
            }

            result.push(token);
        }

        return { scope: this.scope, tokens: result };
    }

    decode(value: unknown, frame: unknown): ItemPayload {
        const payload = decodePayload(value);
        this.bind(payload, frame);

        return payload;
    }

    bind(payload: ItemPayload, frame: unknown): void {
        if (!object(frame) || frame.scope !== this.scope) {
            throw new PlatformError(
                "InvalidProtocol",
                "Managed Item origins belong to another invocation.",
            );
        }

        const tokens = frame.tokens;

        if (!Array.isArray(tokens) || tokens.length > dataNodesMax) {
            throw new PlatformError(
                "InvalidProtocol",
                "Managed Item origins must be a bounded list.",
            );
        }

        const used = new Set<string>();
        let index = 0;

        for (const node of itemNodes(payload)) {
            const token: unknown = tokens[index++];

            if (
                typeof token !== "string" ||
                !/^[bm][1-9]\d{0,6}$/.test(token) ||
                Number(token.slice(1)) > dataNodesMax ||
                used.has(token)
            ) {
                throw new PlatformError(
                    "InvalidProtocol",
                    "Managed Item origins are missing or duplicated.",
                );
            }

            used.add(token);
            let origin = this.origins.get(token);

            if (origin === undefined) {
                if (token.startsWith("b")) {
                    throw new PlatformError(
                        "InvalidProtocol",
                        "Managed Item origin belongs to another invocation.",
                    );
                }

                origin = Symbol("managed Item");
                this.remember(token, origin);
            }

            bindItemOrigin(node, origin);
        }

        if (index !== tokens.length) {
            throw new PlatformError(
                "InvalidProtocol",
                "Managed Item origins do not match the payload.",
            );
        }
    }

    private remember(token: string, origin: symbol): void {
        if (this.origins.size >= dataNodesMax) {
            throw new PlatformError(
                "ProtocolLimit",
                "Managed Item origins exceed their invocation limit.",
            );
        }

        this.tokens.set(origin, token);
        this.origins.set(token, origin);
    }
}
