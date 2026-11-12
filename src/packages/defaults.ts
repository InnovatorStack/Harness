import { baselineEntries } from "../baseline/catalog.js";
import { isBaselineSource } from "../baseline/source.js";
import { setOwn, getOwn } from "../core/data.js";
import { entryKey } from "./draft.js";
import type { ImportDraft, DraftEntry } from "./draft.js";

const baselineTypes = new Map(
    baselineEntries
        .filter((entry) => entry.type === "ItemType")
        .map((entry) => [entry.id, scalarKey(entry.properties.name)]),
);
const baselineTypeIds = new Map([...baselineTypes].map(([id, name]) => [name.toLowerCase(), id]));
const baselinePropertyIds = new Map(
    baselineEntries
        .filter((entry) => entry.type === "Property")
        .map((entry) => {
            const owner = baselineTypes.get(scalarKey(entry.properties.source_id));

            if (owner === undefined) {
                throw new Error(`Built-in Property '${entry.id}' must have a declared ItemType.`);
            }

            return [propertyKey(owner, scalarKey(entry.properties.name)), entry.id];
        }),
);

/** Built-in records are defaults; explicit package definitions take precedence. */
export class PackageDefaults {
    constructor(private readonly draft: ImportDraft) {}

    initialize(): void {
        // Later imports must not resurrect defaults a package changed or deleted.
        const initialized = [...this.draft.entries.values()].some(
            (entry) => entry.type === "ItemType" && entry.properties.name === "ItemType",
        );

        if (initialized) {
            return;
        }

        for (const entry of baselineEntries) {
            const key = entryKey(entry.type, entry.id);

            if (!this.draft.entries.has(key)) {
                this.draft.put({ ...entry, properties: { ...entry.properties } });
            }
        }
    }

    replaceItemType(name: string, nativeId: string): void {
        const previousId = baselineTypeIds.get(name.toLowerCase());
        const existing = previousId
            ? this.draft.entries.get(entryKey("ItemType", previousId))
            : undefined;

        if (
            !existing ||
            !isBaselineSource(existing.source) ||
            existing.id.toLowerCase() === nativeId.toLowerCase()
        ) {
            return;
        }

        this.retargetReferences("ItemType", existing.id, nativeId);
        this.draft.remove(entryKey("ItemType", existing.id), existing);
    }

    replaceProperty(entry: DraftEntry): void {
        const sourceId = scalarKey(entry.properties.source_id);
        const owner = this.draft.entries.get(entryKey("ItemType", sourceId));
        const key = propertyKey(
            scalarKey(owner?.properties.name),
            scalarKey(entry.properties.name),
        );
        const previousId = baselinePropertyIds.get(key);
        const previous = previousId
            ? this.draft.entries.get(entryKey("Property", previousId))
            : undefined;

        if (
            previous &&
            previous.id !== entry.id &&
            isBaselineSource(previous.source) &&
            scalarKey(previous.properties.source_id).toLowerCase() === sourceId.toLowerCase()
        ) {
            this.retargetReferences("Property", previous.id, entry.id);
            this.draft.remove(entryKey("Property", previous.id), previous);
        }
    }

    private retargetReferences(type: string, previousId: string, nextId: string): void {
        const entries = [...this.draft.entries.values()];
        const target = entries.find(
            (entry) => entry.type === "ItemType" && entry.properties.name === type,
        );

        if (!target) {
            return;
        }

        const references = entries.filter(
            (entry) =>
                entry.type === "Property" &&
                entry.properties.data_type === "item" &&
                entry.properties.data_source === target.id,
        );
        const types = new Map(
            entries
                .filter((entry) => entry.type === "ItemType")
                .map((entry) => [entry.id, entry.properties.name]),
        );

        // Explicit package references remain authoritative and are validated after import.
        for (const reference of references) {
            const owner = reference.properties.source_id;
            const name = reference.properties.name;

            if (typeof owner !== "string" || typeof name !== "string") {
                continue;
            }

            for (const entry of entries) {
                const value = getOwn(entry.properties, name);

                if (
                    entry.type === types.get(owner) &&
                    isBaselineSource(entry.source) &&
                    typeof value === "string" &&
                    value.toLowerCase() === previousId.toLowerCase()
                ) {
                    this.draft.touch(entry, [name]);
                    setOwn(entry.properties, name, nextId);
                }
            }
        }
    }
}

function scalarKey(value: unknown): string {
    return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function propertyKey(type: string, name: string): string {
    return JSON.stringify([type.toLowerCase(), name.toLowerCase()]);
}
