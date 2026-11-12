import { spendContext } from "../core/context.js";
import { dataBytesMax } from "../core/limits.js";
import type { ExecutionContext } from "../core/types.js";
import { Item } from "../items/item.js";
import { parseXml } from "../packages/parser.js";
import type { AmlElement } from "../packages/types.js";
import type {
    CatalogEntry,
    HarnessStorage,
    ItemTypeDefinition,
    StorageValue,
} from "../storage/types.js";
import { ApplicationError, PlatformError } from "./errors.js";

interface CachedStructure {
    readonly xml: string;
    readonly paths: ReadonlySet<string>;
    readonly selectable: ReadonlySet<string>;
}

/** Grants may name branches; stored classification values must name leaves or the root. */
export class Classifications {
    private readonly cache = new Map<string, CachedStructure>();
    private readonly rootPaths: ReadonlySet<string> = new Set([""]);
    private readonly rootStructure: CachedStructure = {
        xml: "",
        paths: this.rootPaths,
        selectable: this.rootPaths,
    };

    constructor(private readonly storage: HarnessStorage) {}

    paths(definition: ItemTypeDefinition, context: ExecutionContext): ReadonlySet<string> {
        return this.structure(definition, context).paths;
    }

    assertValue(
        definition: ItemTypeDefinition,
        value: StorageValue | undefined,
        context: ExecutionContext,
    ): void {
        const path = String(value ?? "");

        if (!this.structure(definition, context).selectable.has(path)) {
            throw new ApplicationError(
                Item.error(
                    `Invalid classification '${path}' for '${definition.name}': choose a leaf class or the unclassified root.`,
                    "InvalidClassification",
                ),
            );
        }
    }

    private structure(definition: ItemTypeDefinition, context: ExecutionContext): CachedStructure {
        spendContext(context);
        const metadata = this.storage.getCatalogEntry("ItemType", definition.id);
        const xml = metadata?.properties.class_structure;

        if (xml === undefined || xml === null || xml === "") {
            return this.rootStructure;
        }

        if (typeof xml !== "string") {
            throw invalidStructure(definition, metadata, "class_structure must contain XML text.");
        }

        const cached = this.cache.get(definition.id);

        if (cached?.xml === xml) {
            return cached;
        }

        let root: AmlElement;

        try {
            root = parseXml(xml, metadata?.source.file ?? "class_structure");
        } catch (cause) {
            throw new PlatformError(
                "InvalidClassStructure",
                `Invalid class_structure XML for '${definition.name}'.`,
                { cause, ...(metadata ? { source: metadata.source } : {}) },
            );
        }

        const structure = { xml, ...readPaths(root, definition, metadata, context) };
        this.cache.set(definition.id, structure);

        return structure;
    }
}

function readPaths(
    root: AmlElement,
    definition: ItemTypeDefinition,
    metadata: CatalogEntry | undefined,
    context: ExecutionContext,
): { readonly paths: ReadonlySet<string>; readonly selectable: ReadonlySet<string> } {
    const paths = new Set<string>();
    const selectable = new Set<string>();
    const pending = [{ element: root, path: "" }];
    let pathBytes = 0;

    while (pending.length > 0) {
        spendContext(context);
        const entry = pending.pop();

        if (!entry) {
            throw new Error("A pending class entry must exist.");
        }

        if (entry.element.name.split(":").at(-1) !== "class" || paths.has(entry.path)) {
            throw invalidStructure(definition, metadata, "Expected unique class paths.");
        }

        paths.add(entry.path);
        selectable.add(entry.path);

        for (const child of entry.element.children) {
            spendContext(context);

            if (child.kind !== "element") {
                if (child.value.trim()) {
                    throw invalidStructure(definition, metadata, "Classes cannot contain text.");
                }

                continue;
            }

            const name = child.attributes.name;
            selectable.delete(entry.path);

            if (!name || name.includes("/")) {
                throw invalidStructure(definition, metadata, "Class names must be path segments.");
            }

            const length = entry.path.length + name.length + (entry.path ? 1 : 0);
            const bytes = length * 3;

            if (bytes > dataBytesMax - pathBytes) {
                throw invalidStructure(definition, metadata, "Class paths exceed the text limit.");
            }

            pathBytes += bytes;
            spendContext(context, length);
            const path = entry.path ? `${entry.path}/${name}` : name;
            pending.push({ element: child, path });
        }
    }

    selectable.add("");

    return { paths, selectable };
}

function invalidStructure(
    definition: ItemTypeDefinition,
    metadata: CatalogEntry | undefined,
    detail: string,
): PlatformError {
    return new PlatformError(
        "InvalidClassStructure",
        `Invalid class_structure for '${definition.name}': ${detail}`,
        metadata ? { source: metadata.source } : undefined,
    );
}
