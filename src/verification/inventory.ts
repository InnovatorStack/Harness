import { setOwn } from "../core/data.js";
import { childElements, textContent, walkElements } from "../packages/elements.js";
import type { AmlDocument, AmlElement } from "../packages/types.js";
import type { PackageMethodDeclaration, PackageSqlDeclaration } from "./types.js";

function property(item: AmlElement, name: string): string | undefined {
    const element = childElements(item).find((child) => child.name === name);

    if (!element || element.attributes.is_null === "1") {
        return undefined;
    }

    return textContent(element);
}

function hash(source: string): string {
    return new Bun.CryptoHasher("sha256").update(source).digest("hex");
}

export function inventory(documents: readonly AmlDocument[]): {
    readonly methods: readonly PackageMethodDeclaration[];
    readonly sql: readonly PackageSqlDeclaration[];
} {
    const methods: PackageMethodDeclaration[] = [];
    const sql: PackageSqlDeclaration[] = [];

    for (const document of documents) {
        for (const element of walkElements(document.items)) {
            inventoryElement(element, methods, sql);
        }
    }

    return { methods: Object.freeze(methods), sql: Object.freeze(sql) };
}

function inventoryElement(
    element: AmlElement,
    methods: PackageMethodDeclaration[],
    sql: PackageSqlDeclaration[],
): void {
    const action = element.attributes.action ?? "get";
    const type = element.attributes.type?.trim().toLowerCase();

    if (element.name === "Item" && action !== "get" && action !== "delete") {
        const id = element.attributes.id;
        const name = property(element, "name");
        const declaration = {
            action,
            ...(id === undefined ? {} : { id }),
            ...(name === undefined ? {} : { name }),
            source: element.source,
        };

        if (type === "method") {
            const language = property(element, "method_type");
            const code = property(element, "method_code");
            methods.push(
                Object.freeze({
                    ...declaration,
                    ...(language === undefined ? {} : { language }),
                    ...(code === undefined ? {} : { codeHash: hash(code) }),
                }),
            );
        } else if (type === "sql") {
            const bodies: Record<string, string> = {};

            for (const child of childElements(element)) {
                if (child.name.endsWith("_body") && child.attributes.is_null !== "1") {
                    setOwn(bodies, child.name, hash(textContent(child)));
                }
            }

            sql.push(Object.freeze({ ...declaration, bodyHashes: Object.freeze(bodies) }));
        }
    }
}
