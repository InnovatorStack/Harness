import { metadataEpoch } from "../../storage/metadata-epoch.js";
import type { HarnessStorage, ItemTypeDefinition } from "../../storage/types.js";
import { PlatformError } from "../errors.js";
import { eventOwners } from "./inheritance.js";
import { ServerEventVersion } from "./types.js";
import type { EventBinding } from "./types.js";
import { eventVersion } from "./version.js";

export class EventBindings {
    private epoch: number | undefined;
    private readonly selections = new Map<string, readonly EventBinding[]>();

    constructor(private readonly storage: HarnessStorage) {}

    select(
        definition: ItemTypeDefinition,
        name: string,
        enabled = true,
        version = ServerEventVersion.Item,
    ): readonly EventBinding[] {
        const epoch = metadataEpoch(this.storage);

        if (epoch === undefined || this.epoch !== epoch) {
            this.selections.clear();
            this.epoch = epoch;
        }

        const key = JSON.stringify([
            definition.id.toLowerCase(),
            name.toLowerCase(),
            enabled,
            version,
        ]);
        const cached = this.selections.get(key);

        if (cached) {
            return cached;
        }

        const bindings = this.collect(definition, name, enabled, version);

        if (epoch !== undefined) {
            this.selections.set(key, bindings);
        }

        return bindings;
    }

    private collect(
        definition: ItemTypeDefinition,
        name: string,
        enabled: boolean,
        version: ServerEventVersion,
    ): readonly EventBinding[] {
        const owners = eventOwners(this.storage, definition.id);
        const bindings: EventBinding[] = [];

        for (const entry of this.storage.listCatalogEntries("Server Event")) {
            const properties = entry.properties;
            const required = String(properties.is_required ?? "0") === "1";

            if (
                !owners.has(String(properties.source_id).toLowerCase()) ||
                String(properties.server_event).toLowerCase() !== name.toLowerCase() ||
                (!enabled && !required)
            ) {
                continue;
            }

            const declared = eventVersion(name, properties.event_version, entry.source);

            if (declared !== version) {
                continue;
            }

            const methodId = properties.related_id;

            if (
                typeof methodId !== "string" ||
                !Number.isSafeInteger(Number(properties.sort_order ?? 0))
            ) {
                throw new PlatformError(
                    "InvalidEvent",
                    `Event '${entry.id}' needs a Method and a safe integer sort order.`,
                    { source: entry.source },
                );
            }

            bindings.push({ entry, methodId, required, version: declared });
        }

        bindings.sort(
            (left, right) =>
                Number(left.entry.properties.sort_order ?? 0) -
                Number(right.entry.properties.sort_order ?? 0),
        );
        this.assertOrder(definition, name, bindings);

        return Object.freeze(bindings);
    }

    private assertOrder(
        definition: ItemTypeDefinition,
        name: string,
        bindings: readonly EventBinding[],
    ): void {
        for (let index = 1; index < bindings.length; index += 1) {
            const previous = bindings[index - 1];
            const current = bindings[index];

            if (!previous || !current) {
                throw new Error(
                    "Adjacent event bindings must exist before their collection boundary.",
                );
            }

            if (
                Number(previous.entry.properties.sort_order ?? 0) ===
                Number(current.entry.properties.sort_order ?? 0)
            ) {
                throw new PlatformError(
                    "AmbiguousEventOrder",
                    `Events for '${definition.name}.${name}' have the same sort order within '${current.version}'.`,
                    { source: current.entry.source },
                );
            }
        }
    }
}
