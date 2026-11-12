import { dirname, isAbsolute } from "node:path";

import { init, parse } from "es-module-lexer";

/** External imports must resolve from their source file, not the temporary setup bundle. */
export async function resolveSetupImports(source: string, path: string): Promise<string> {
    await init();
    const [imports] = parse(source, path);
    const fragments: string[] = [];
    let copied = 0;

    for (const entry of imports) {
        const specifier = entry.specifier;

        if (
            !specifier ||
            specifier.startsWith(".") ||
            specifier.startsWith("/") ||
            specifier.startsWith("file:") ||
            (entry.type === "dynamic" && entry.glob)
        ) {
            continue;
        }

        const resolved = Bun.resolveSync(specifier, dirname(path));

        if (!isAbsolute(resolved)) {
            continue;
        }

        const url = Bun.pathToFileURL(resolved).href;
        const replacement = entry.type === "dynamic" ? JSON.stringify(url) : url;
        fragments.push(source.slice(copied, entry.start), replacement);
        copied = entry.end;
    }

    fragments.push(source.slice(copied));

    return fragments.join("");
}
