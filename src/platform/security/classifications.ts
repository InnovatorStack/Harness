import { spendContext } from "../../core/context.js";
import { dataBytesMax } from "../../core/limits.js";
import type { ExecutionContext } from "../../core/types.js";
import { parseXml } from "../../packages/parser.js";
import type { AmlElement } from "../../packages/types.js";
import type { CatalogEntry, HarnessStorage, ItemTypeDefinition } from "../../storage/types.js";
import { PlatformError } from "../errors.js";

interface CachedStructure {
    readonly xml: string;
    readonly paths: ReadonlySet<string>;
}

/** Creation grants refer to names in the imported tree, including its unnamed root. */
export class Classifications {
    private readonly cache = new Map<string, CachedStructure>();
    private readonly rootPaths: ReadonlySet<string> = new Set([""]);

    constructor(private readonly storage: HarnessStorage) {}

    paths(definition: ItemTypeDefinition, context: ExecutionContext): ReadonlySet<string> {
        spendContext(context);
        const metadata = this.storage.getCatalogEntry("ItemType", definition.id);
        const xml = metadata?.properties.class_structure;

        if (xml === undefined || xml === null || xml === "") {
            return this.rootPaths;
        }

        if (typeof xml !== "string") {
            throw invalidStructure(definition, metadata, "class_structure must contain XML text.");
        }

        const cached = this.cache.get(definition.id);

        if (cached?.xml === xml) {
            return cached.paths;
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

        const paths = readPaths(root, definition, metadata, context);
        this.cache.set(definition.id, { xml, paths });

        return paths;
    }
}

function readPaths(
    root: AmlElement,
    definition: ItemTypeDefinition,
    metadata: CatalogEntry | undefined,
    context: ExecutionContext,
): ReadonlySet<string> {
    const paths = new Set<string>();
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

        for (const child of entry.element.children) {
            spendContext(context);

            if (child.kind !== "element") {
                if (child.value.trim()) {
                    throw invalidStructure(definition, metadata, "Classes cannot contain text.");
                }

                continue;
            }

            const name = child.attributes.name;

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

    return paths;
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
