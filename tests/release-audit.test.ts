import { expect, test } from "bun:test";

import { assertPublicText, auditDistribution } from "../scripts/release/audit.js";
import { builtinDatabase } from "../src/baseline/database.js";
import { SqliteStorage } from "../src/storage/sqlite/storage.js";

function publicFiles(baseline = builtinDatabase()): Map<string, Blob> {
    const files = new Map([
        ["package/src/index.ts", new Blob(["export {};"])],
        ["package/dist/baseline/database.bin", new Blob([new Uint8Array(baseline)])],
        [
            "package/package.json",
            new Blob([
                JSON.stringify({
                    exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
                }),
            ]),
        ],
    ]);

    for (const name of ["index.js", "index.d.ts"]) {
        files.set(
            `package/dist/${name}`,
            new Blob([`export {};\n//# sourceMappingURL=${name}.map\n`]),
        );
        files.set(
            `package/dist/${name}.map`,
            new Blob([
                JSON.stringify({
                    version: 3,
                    file: name,
                    sourceRoot: "",
                    sources: ["../src/index.ts"],
                    mappings: "",
                }),
            ]),
        );
    }

    return files;
}

test("distribution review accepts the curated baseline and rejects private paths", async () => {
    const files = publicFiles();
    await auditDistribution(files);
    files.set("package/workspaces/private.xml", new Blob(["private"]));
    await expect(auditDistribution(files)).rejects.toThrow("Unexpected distribution path");
});

test("distribution review rejects changed baseline rows even without identifying strings", async () => {
    const storage = new SqliteStorage();

    try {
        storage.restore(builtinDatabase());
        storage.insertItem({
            type: "Identity",
            id: "UNREVIEWED_RECORD",
            properties: { name: "Unreviewed" },
        });
        const files = publicFiles(storage.snapshot());
        await expect(auditDistribution(files)).rejects.toThrow("curated platform-only build");
    } finally {
        storage.close();
    }
});

test("distribution review rejects credentials and workstation paths without echoing their contents", () => {
    const token = `ghp_${"a".repeat(36)}`;
    const path = ["", "home", "example-user", "Documents", "private.xml"].join("/");

    for (const text of [token, path]) {
        let message = "";

        try {
            assertPublicText("published.txt", text);
        } catch (error) {
            message = error instanceof Error ? error.message : String(error);
        }

        expect(message).toContain("Potential confidential content");
        expect(message).not.toContain(text);
    }
});

test("distribution review rejects public exports that are absent from the archive", async () => {
    const files = publicFiles();
    files.delete("package/dist/index.d.ts");
    await expect(auditDistribution(files)).rejects.toThrow("outside the distribution");
});

test("published JavaScript and declaration maps resolve to the same included framework source", async () => {
    expect(await auditDistribution(publicFiles())).toEqual({ maps: 2, sources: 1 });
});

test("distribution review rejects missing debugger and declaration source targets", async () => {
    const files = publicFiles();
    files.delete("package/src/index.ts");
    await expect(auditDistribution(files)).rejects.toThrow("Missing packaged framework source");
});

test("distribution review rejects dangling generated source map references", async () => {
    const files = publicFiles();
    files.delete("package/dist/index.js.map");
    await expect(auditDistribution(files)).rejects.toThrow("Missing generated source map");
});

test("including framework source does not admit local managed outputs or unrelated JSON", async () => {
    for (const path of [
        "package/src/methods/csharp/managed/obj/project.assets.json",
        "package/src/local-settings.json",
    ]) {
        const files = publicFiles();
        files.set(path, new Blob(["{}"]));
        await expect(auditDistribution(files)).rejects.toThrow("Unexpected distribution path");
    }
});
