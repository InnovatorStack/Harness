import { spendContext } from "../../core/context.js";
import type { ExecutionContext } from "../../core/types.js";
import type { ItemNode } from "../../items/item.js";
import { evaluate } from "../../queries/evaluate.js";
import type { SelectQuery } from "../../queries/types.js";
import type { HarnessStorage, ItemTypeDefinition, StoredItem } from "../../storage/types.js";
import { fieldValue } from "./fields.js";
import { orderBy, orderRows } from "./order.js";
import { pageRows } from "./paging.js";
import type { PageSelection } from "./paging.js";
import { requestPredicate } from "./planner.js";
import type { ApplyQueryItem } from "./planner.js";
import { RelationshipQueries } from "./relationships.js";

/** Schema resolution and execution policy are shared; SQLite only optimizes predicate selection. */
export class ItemQueries {
    constructor(
        private readonly storage: HarnessStorage,
        private readonly apply: ApplyQueryItem,
        private readonly select?: SelectQuery,
        private readonly visible?: (
            definition: ItemTypeDefinition,
            records: readonly StoredItem[],
            context: ExecutionContext,
        ) => readonly StoredItem[],
    ) {}

    async run(
        definition: ItemTypeDefinition,
        request: ItemNode,
        context: ExecutionContext,
    ): Promise<PageSelection> {
        const predicate = await requestPredicate(
            this.storage,
            definition,
            request,
            context,
            this.apply,
        );
        const orders = orderBy(this.storage, definition, request.attributes.orderBy);
        const spend = (units: number) => {
            spendContext(context, units);
        };
        const candidates = this.select
            ? this.select(definition.name, predicate, spend)
            : this.storage.listItems(definition.name);
        const filtered = candidates.filter((record) =>
            evaluate(predicate, (field) => fieldValue(this.storage, record, field), spend),
        );
        const matching =
            (request.attributes.action ?? "get") === "get" && this.visible
                ? this.visible(definition, filtered, context)
                : filtered;

        if (request.relationships.length === 0 || (request.attributes.action ?? "get") !== "get") {
            return pageRows(request, orderRows(this.storage, matching, orders, spend));
        }

        const nested = await new RelationshipQueries(this.storage, this.apply).select(
            definition,
            request,
            matching,
            context,
        );
        const page = pageRows(request, orderRows(this.storage, nested.records, orders, spend));

        return { ...page, relationships: nested.relationships };
    }
}
