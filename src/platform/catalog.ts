import { CapabilityId } from "../compatibility/capabilities.js";
import type { SourceLocation } from "../diagnostics/source-location.js";
import type { MethodDefinition } from "../methods/types.js";
import { presentationTypes } from "../packages/bootstrap.js";
import { walkElements } from "../packages/elements.js";
import { parseAml } from "../packages/parser.js";
import { findDocument } from "../storage/documents.js";
import { metadataEpoch } from "../storage/metadata-epoch.js";
import type { CatalogEntry, HarnessStorage, ItemTypeDefinition } from "../storage/types.js";
import { Classifications } from "./classifications.js";
import { PlatformError } from "./errors.js";
import { EventBindings } from "./events/bindings.js";
import { ServerEventVersion } from "./events/types.js";

const definitionTypes = new Set([
    "itemtype",
    "property",
    "relationshiptype",
    "morphae",
    "revision",
    "method",
    "sql",
    "server event",
    "life cycle map",
    "life cycle state",
    "life cycle transition",
    "itemtype life cycle",
]);

const sourceLocationsMax = 512;
const sourceLocations = new Map<string, SourceLocation>();

/** Source coordinates depend on original XML bytes, independently of a world's database. */
function methodCodeSource(storage: HarnessStorage, original: SourceLocation): SourceLocation {
    const document = findDocument(storage, original.file);

    if (!document) {
        return original;
    }

    const path = `${original.path}/method_code[1]`;
    const key = JSON.stringify([
        document.path,
        new Bun.CryptoHasher("sha256").update(document.xml).digest("hex"),
        path,
    ]);
    const cached = sourceLocations.get(key);

    if (cached) {
        return cached;
    }

    for (const element of walkElements(parseAml(document.xml, document.path).items)) {
        if (element.source.path === path) {
            if (sourceLocations.size >= sourceLocationsMax) {
                sourceLocations.clear();
            }

            const source = Object.freeze({ ...element.source });
            sourceLocations.set(key, source);

            return source;
        }
    }

    return original;
}

export class PlatformCatalog {
    readonly classifications: Classifications;
    private readonly bindings: EventBindings;
    private epoch: number | undefined;
    private methods: Map<string, CatalogEntry[]> | undefined;
    private readonly definitions = new Map<string, MethodDefinition>();

    constructor(private readonly storage: HarnessStorage) {
        this.classifications = new Classifications(storage);
        this.bindings = new EventBindings(storage);
    }

    assertMutable(definition: ItemTypeDefinition): void {
        if (presentationTypes.has(definition.name)) {
            throw new PlatformError(
                "UnsupportedPresentation",
                `Presentation metadata '${definition.name}' is retained from its package; changing it requires a presentation adapter.`,
            );
        }

        if (definitionTypes.has(definition.name.toLowerCase())) {
            throw new PlatformError(
                "UnsupportedDefinitionMutation",
                `Changes to '${definition.name}' definitions must be loaded through packages. Runtime definition mutation is not implemented.`,
            );
        }
    }

    itemType(name: string): ItemTypeDefinition {
        const definition = this.storage.getItemType(name);

        if (!definition) {
            const metadata = this.storage
                .listCatalogEntries("ItemType")
                .find(
                    (entry) => String(entry.properties.name).toLowerCase() === name.toLowerCase(),
                );

            if (metadata && metadata.properties.implementation_type !== "table") {
                throw new PlatformError(
                    "UnsupportedImplementation",
                    `ItemType '${name}' uses '${metadata.properties.implementation_type}' storage and requires an adapter. Its metadata is available through ItemType queries.`,
                    {
                        capability:
                            String(metadata.properties.implementation_type).toLowerCase() ===
                            "polymorphic"
                                ? CapabilityId.Polymorphism
                                : CapabilityId.Federation,
                    },
                );
            }

            throw new PlatformError("MissingItemType", `ItemType '${name}' has not been imported.`);
        }

        return definition;
    }

    methodEntry(nameOrId: string) {
        this.refreshMethods();
        const candidates = this.methods?.get(nameOrId.toLowerCase()) ?? [];
        const current = candidates.filter(
            (entry) => entry.properties.is_current !== 0 && entry.properties.is_current !== "0",
        );

        if (current.length > 1) {
            throw new PlatformError(
                "MethodResolution",
                `Method '${nameOrId}' resolved to ${current.length} current definitions.`,
            );
        }

        return current[0];
    }

    private refreshMethods(): void {
        const epoch = metadataEpoch(this.storage);

        if (epoch !== undefined && this.methods && this.epoch === epoch) {
            return;
        }

        this.epoch = epoch;
        this.methods = new Map();
        this.definitions.clear();

        for (const entry of this.storage.listCatalogEntries("Method")) {
            const keys = new Set([entry.id, entry.properties.name, entry.properties.config_id]);

            for (const key of keys) {
                if (typeof key !== "string") {
                    continue;
                }

                const normalized = key.toLowerCase();
                const entries = this.methods.get(normalized) ?? [];

                if (!entries.includes(entry)) {
                    entries.push(entry);
                }

                this.methods.set(normalized, entries);
            }
        }
    }

    method(nameOrId: string): MethodDefinition {
        const method = this.methodEntry(nameOrId);

        if (!method) {
            throw new PlatformError("MethodResolution", `Missing Method '${nameOrId}'.`);
        }

        const cached = this.definitions.get(method.id);

        if (cached) {
            return cached;
        }

        const name = method.properties.name;
        const language = method.properties.method_type;
        const code = method.properties.method_code;

        if (typeof name !== "string" || typeof language !== "string" || typeof code !== "string") {
            throw new PlatformError(
                "InvalidMethod",
                `Method '${nameOrId}' is missing its name, language or source.`,
            );
        }

        const definition = Object.freeze({
            id: method.id,
            name,
            language,
            code,
            source: Object.freeze({ ...methodCodeSource(this.storage, method.source) }),
            hash: new Bun.CryptoHasher("sha256").update(code).digest("hex"),
        });
        this.definitions.set(method.id, definition);

        return definition;
    }

    events(
        definition: ItemTypeDefinition,
        name: string,
        enabled = true,
        version = ServerEventVersion.Item,
    ) {
        return this.bindings.select(definition, name, enabled, version);
    }
}
