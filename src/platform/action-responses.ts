import { spendContext } from "../core/context.js";
import { dataDepthMax, dataNodesMax } from "../core/limits.js";
import type { ExecutionContext } from "../core/types.js";
import { Item, itemNode } from "../items/item.js";
import type { ItemNode } from "../items/item.js";
import { ApplicationError, PlatformError } from "./errors.js";
import type { ApplyQueryItem } from "./queries/planner.js";

const fetchedActions = new Set(["add", "edit", "update", "lock", "unlock"]);

/** Return retrieval is an action phase, distinct from persistence and its mutation hooks. */
export class ActionResponses {
    constructor(
        private readonly apply: ApplyQueryItem,
        private readonly hasAfterEvents: (type: string) => boolean,
    ) {}

    prepare(request: ItemNode, context: ExecutionContext): void {
        if (request.attributes.doGetItem === undefined || request.attributes.doGetItem === "") {
            request.attributes.doGetItem = "1";
        }

        const pending = [{ node: request, depth: 0 }];
        let visited = 0;

        while (pending.length > 0) {
            spendContext(context);
            const frame = pending.pop();

            if (!frame || ++visited > dataNodesMax || frame.depth > dataDepthMax) {
                throw new PlatformError(
                    "ProtocolLimit",
                    "Action responses exceed their input limit.",
                );
            }

            const node = frame.node;

            if (frame.depth > 0 && !node.attributes.doGetItem) {
                node.attributes.doGetItem = this.hasAfterEvents(node.type) ? "1" : "0";
            }

            for (const child of [...Object.values(node.propertyItems), ...node.relationships]) {
                pending.push({ node: child, depth: frame.depth + 1 });
            }
        }
    }

    async complete(request: ItemNode, response: Item, context: ExecutionContext): Promise<Item> {
        const action = request.attributes.action ?? "get";

        if (response.isError() || response.payload.result !== undefined) {
            return response;
        }

        if (action === "delete") {
            return new Item({ items: [], result: "Ok" });
        }

        if (!fetchedActions.has(action)) {
            return response;
        }

        if (request.attributes.doGetItem === "0") {
            if (action === "lock" || action === "unlock") {
                return new Item({ items: [], result: "Ok." });
            }

            return new Item({ items: response.payload.items.map(identityNode) });
        }

        return await this.fetch(request, response, context);
    }

    private async fetch(
        request: ItemNode,
        response: Item,
        context: ExecutionContext,
    ): Promise<Item> {
        const query = Item.create(request.type, "get");
        const ids = response.payload.items.map((node) => node.attributes.id ?? "");

        if (ids.length === 0 || ids.some((id) => !id)) {
            throw new PlatformError(
                "InvalidActionResult",
                "A default action must retain its target IDs.",
            );
        }

        query.setAttribute("idlist", ids.join(","));

        if (request.attributes.select) {
            query.setAttribute("select", request.attributes.select);
        }

        const action = request.attributes.action;

        if (request.attributes.serverEvents === "0" && action !== "lock" && action !== "unlock") {
            query.setAttribute("serverEvents", "0");
        }

        const result = await this.apply(query, context);

        if (result.isError()) {
            throw new ApplicationError(result);
        }

        const positions = new Map(ids.map((id, index) => [id.toLowerCase(), index]));
        result.payload.items.sort(
            (left, right) =>
                (positions.get((left.attributes.id ?? "").toLowerCase()) ?? ids.length) -
                (positions.get((right.attributes.id ?? "").toLowerCase()) ?? ids.length),
        );

        return result;
    }
}

function identityNode(node: ItemNode): ItemNode {
    const id = node.attributes.id;

    if (!id) {
        throw new PlatformError("InvalidActionResult", "A minimal response requires its Item ID.");
    }

    return { ...itemNode(node.type), attributes: { id } };
}
