import type { SourceLocation } from "../diagnostics/source-location.js";
import { object } from "../items/codec.js";
import { Item } from "../items/item.js";
import { validateParameters } from "../mocks/parameters.js";
import { properties } from "../mocks/registry.js";
import type { MockValue } from "../mocks/types.js";
import { PlatformCatalog } from "../platform/catalog.js";
import type { SourceDefinition } from "../platform/trace.js";
import type { CatalogEntry, HarnessStorage } from "../storage/types.js";

export interface InjectionDetails {
    readonly kind: "action" | "method" | "sql";
    readonly name: string;
    readonly source?: SourceLocation;
    readonly definition?: SourceDefinition;
    readonly sourceHash?: string;
}

export interface InjectionTarget extends InjectionDetails {
    readonly aliases: readonly (string | true)[];
    readonly action?: string;
    readonly values: Readonly<Record<string, MockValue>>;
}

/** Resolve invocation metadata without compiling or running the selected implementation. */
export function injectionTarget(
    storage: HarnessStorage,
    operation: string,
    input: unknown,
): InjectionTarget | undefined {
    if (operation === "platform.apply" && input instanceof Item && input.getItemCount() === 1) {
        const type = input.getType();
        const action = input.getAction() || "get";

        if (type.toLowerCase() === "sql" && /^sql\s+process$/iu.test(action)) {
            const name = input.getProperty("name");
            const entry = storage
                .listCatalogEntries("SQL")
                .find((entry) => entry.properties.name === name);

            return {
                kind: "sql",
                name,
                aliases: [name],
                values: properties(input),
                ...sourceDetails(entry, "SQL", "sqlserver_body"),
            };
        }

        return {
            kind: "action",
            name: `${type}.${action}`,
            aliases: [type],
            action,
            values: properties(input),
        };
    }

    if (
        operation === "platform.method" &&
        object(input) &&
        typeof input.name === "string" &&
        input.context instanceof Item
    ) {
        const entry = new PlatformCatalog(storage).methodEntry(input.name);
        const name =
            typeof entry?.properties.name === "string" ? entry.properties.name : input.name;

        return {
            kind: "method",
            name,
            aliases: [input.name, name, ...(entry ? [entry.id] : [])],
            values: properties(input.context),
            ...sourceDetails(entry, "Method", "method_code"),
        };
    }

    if (
        operation === "platform.sql" &&
        object(input) &&
        typeof input.method === "string" &&
        typeof input.query === "string" &&
        object(input.values)
    ) {
        return {
            kind: "sql",
            name: `SQL: ${input.method}`,
            aliases: [true],
            values: inlineValues(input.values, input.method, input.query),
        };
    }

    return undefined;
}

function sourceDetails(entry: CatalogEntry | undefined, type: "Method" | "SQL", body: string) {
    if (!entry) {
        return {};
    }

    const code = entry.properties[body];

    return {
        source: entry.source,
        definition: { type, id: entry.id },
        ...(typeof code === "string"
            ? { sourceHash: new Bun.CryptoHasher("sha256").update(code).digest("hex") }
            : {}),
    };
}

function inlineValues(values: Record<string, unknown>, method: string, query: string) {
    validateParameters(values, "SQL invocation parameters");

    return { ...values, method, query };
}
