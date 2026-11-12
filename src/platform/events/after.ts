import { spendContext } from "../../core/context.js";
import type { ExecutionContext } from "../../core/types.js";
import { Item } from "../../items/item.js";
import { MethodEventDataKind } from "../../methods/event-data.js";
import type { MethodEventData } from "../../methods/event-data.js";
import type { ItemTypeDefinition } from "../../storage/types.js";
import { PlatformError, requireSuccess } from "../errors.js";
import type { ApplyQueryItem } from "../queries/planner.js";
import { ServerEventVersion } from "./types.js";
import type { AfterEventItem, EventBinding } from "./types.js";

type SelectEvents = (
    definition: ItemTypeDefinition,
    name: string,
    enabled: boolean,
    version: ServerEventVersion,
) => readonly EventBinding[];

type InvokeEvent = (
    binding: EventBinding,
    name: string,
    item: Item,
    context: ExecutionContext,
    data: MethodEventData,
) => Promise<void>;

interface AfterSelection {
    readonly bindings: readonly EventBinding[];
    readonly needsItems: boolean;
}

/** After-event documents are loaded once and shared between bindings, independently of results. */
export class AfterEvents {
    constructor(
        private readonly select: SelectEvents,
        private readonly invoke: InvokeEvent,
        private readonly apply: ApplyQueryItem,
    ) {}

    async run(
        definition: ItemTypeDefinition,
        name: string,
        frames: readonly AfterEventItem[],
        enabled: boolean,
        context: ExecutionContext,
    ): Promise<void> {
        spendContext(context, frames.length);
        const { bindings, needsItems } = this.selection(definition, name, enabled);

        if (frames.length === 0 || (bindings.length === 0 && !needsItems)) {
            return;
        }

        const items = needsItems
            ? await this.load(definition, frames, enabled || name === "onAfterAdd", context)
            : new Map<string, Item>();

        for (const binding of bindings) {
            spendContext(context);

            if (binding.version === ServerEventVersion.Collection) {
                const first = frames[0];

                if (!first) {
                    throw new Error("A nonempty after-event batch must retain its first frame.");
                }

                const data = this.batchData(first.data, needsItems);
                await this.invoke(binding, name, Item.create(""), context, data);

                continue;
            }

            for (const frame of frames) {
                const item = items.get(frame.id.toLowerCase());

                if (!item) {
                    throw new PlatformError("MissingItem", "An after-event context is missing.");
                }

                await this.invoke(binding, name, item, context, frame.data);
            }
        }
    }

    private selection(
        definition: ItemTypeDefinition,
        name: string,
        enabled: boolean,
    ): AfterSelection {
        const itemBindings = this.select(definition, name, enabled, ServerEventVersion.Item);
        const bindings = [
            ...itemBindings,
            ...this.select(definition, name, enabled, ServerEventVersion.Collection),
        ].sort(
            (left, right) =>
                Number(left.entry.properties.sort_order ?? 0) -
                Number(right.entry.properties.sort_order ?? 0),
        );
        // Native after-update prepares its contexts before optional bindings are suppressed.
        const needsItems =
            itemBindings.length > 0 ||
            (name === "onAfterUpdate" &&
                !enabled &&
                this.select(definition, name, true, ServerEventVersion.Item).length > 0);

        return { bindings, needsItems };
    }

    private async load(
        definition: ItemTypeDefinition,
        frames: readonly AfterEventItem[],
        enabled: boolean,
        context: ExecutionContext,
    ): Promise<ReadonlyMap<string, Item>> {
        const request = Item.create(definition.name, "get");
        request.setAttribute("idlist", frames.map((frame) => frame.id).join(","));
        request.setAttribute("serverEvents", enabled ? "1" : "0");
        const result = requireSuccess(await this.apply(request, context));
        const items = new Map(
            result.payload.items.map((node) => [
                (node.attributes.id ?? "").toLowerCase(),
                new Item({ items: [node] }),
            ]),
        );

        if (result.isError() || frames.some((frame) => !items.has(frame.id.toLowerCase()))) {
            throw new PlatformError("MissingItem", "An after-event Get omitted a required Item.");
        }

        return items;
    }

    private batchData(data: MethodEventData, hasItemBindings: boolean): MethodEventData {
        if (hasItemBindings) {
            return data;
        }

        if (data.kind === MethodEventDataKind.AfterVersion) {
            return { ...data, newItemId: "" };
        }

        if (data.kind === MethodEventDataKind.AfterUpdate) {
            return { ...data, id: null };
        }

        return data;
    }
}
