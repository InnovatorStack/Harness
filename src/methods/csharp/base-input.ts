import type { Item } from "../../items/item.js";
import { itemOrigin } from "../../items/origins.js";
import { PlatformError } from "../../platform/errors.js";
import { documentInput, documentRoot } from "./documents.js";
import type { DocumentInput } from "./documents.js";
import type { ManagedOrigins, OriginFrame } from "./origins.js";
import { requestDifference } from "./request-change.js";
import type { RequestChange } from "./request-change.js";

export interface BaseInputChange {
    readonly request?: RequestChange;
    readonly origins: OriginFrame;
    readonly document?: DocumentInput;
    readonly documentOrigins?: OriginFrame;
}

/** Keep the default action's selected node independent of its changing document. */
export class BaseInput {
    private readonly before;
    private readonly selected;
    private readonly root;

    constructor(readonly item: Item) {
        this.before = item.clone().node;
        this.selected = item.node;
        this.root = documentRoot(item);
    }

    change(origins: ManagedOrigins): BaseInputChange | undefined {
        const current = this.item.payload.items[0];
        const detached = !current || itemOrigin(current) !== itemOrigin(this.selected);
        const captured = detached ? this.selected : current;
        const request = requestDifference(this.before, captured);

        if (!detached) {
            if (documentRoot(this.item) !== this.root) {
                throw new PlatformError(
                    "UnsupportedRequestIdentity",
                    "Moving a retained base request into another XML container is not qualified.",
                );
            }

            return request ? { request, origins: origins.capture(this.item.payload) } : undefined;
        }

        const document = documentInput(this.item);

        if (!document) {
            throw new PlatformError(
                "UnsupportedRequestIdentity",
                "A replaced base document requires its native XML and captured request.",
            );
        }

        return {
            ...(request ? { request } : {}),
            origins: origins.capture({ items: [captured] }),
            document,
            documentOrigins: origins.capture(this.item.payload),
        };
    }
}
