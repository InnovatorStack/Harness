import type { MethodFile } from "../methods/sources.js";
import { methodFileLocation } from "../methods/sources.js";
import type { CatalogEntry } from "../storage/types.js";

/** Resolve named source files without changing imported records or their event bindings. */
export class MethodSources {
    private readonly files = new Map<string, MethodFile>();
    private readonly entries = new Map<string, CatalogEntry>();

    constructor(files: readonly MethodFile[] = []) {
        for (const file of files) {
            this.files.set(file.name.toLowerCase(), file);

            if (!("missing" in file)) {
                const entry = standaloneMethod(file);
                this.entries.set(file.name.toLowerCase(), entry);
                this.entries.set(entry.id.toLowerCase(), entry);
            }
        }
    }

    entry(name: string): CatalogEntry | undefined {
        return this.entries.get(name.toLowerCase());
    }

    file(entry: CatalogEntry): MethodFile | undefined {
        const name = entry.properties.name;

        return typeof name === "string" ? this.files.get(name.toLowerCase()) : undefined;
    }

    owns(entry: CatalogEntry): boolean {
        return this.entries.get(entry.id.toLowerCase()) === entry;
    }
}

function standaloneMethod(file: MethodFile): CatalogEntry {
    const id = new Bun.CryptoHasher("sha256")
        .update(`harness-method:${file.name.toLowerCase()}`)
        .digest("hex")
        .slice(0, 32)
        .toUpperCase();

    return Object.freeze({
        id,
        type: "Method",
        attributes: Object.freeze({ id, type: "Method" }),
        source: methodFileLocation(file),
        properties: Object.freeze({
            name: file.name,
            method_type: "C#",
            method_code: "code" in file ? file.code : "",
            config_id: id,
            generation: 1,
            is_current: 1,
        }),
    });
}
