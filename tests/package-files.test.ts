import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { loadAmlDocuments, PackageFileError } from "../src/packages/files.js";

let directory: string;

beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "innovator-harness-packages-"));
});

afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
});

describe("loadAmlDocuments", () => {
    test("preserves caller order and sorts XML inputs recursively within each directory", async () => {
        const packagePath = join(directory, "package");
        await mkdir(join(packagePath, "a"), { recursive: true });
        await writeFile(join(directory, "first.xml"), '<Item type="Identity" id="FIRST" />');
        await writeFile(join(packagePath, "b.xml"), '<Item type="Identity" id="B" />');
        await writeFile(join(packagePath, "A.XML"), '<Item type="Identity" id="A" />');
        await writeFile(join(packagePath, "a.xml"), '<Item type="Identity" id="LOWER_A" />');
        await writeFile(
            join(packagePath, "a", "nested.xml"),
            '<Item type="Identity" id="NESTED" />',
        );
        await writeFile(join(packagePath, "ignored.txt"), "not XML");
        const documents = await loadAmlDocuments([
            { path: join(directory, "first.xml") },
            { path: packagePath },
        ]);
        expect(documents.map((document) => basename(document.file))).toEqual([
            "first.xml",
            "A.XML",
            "a.xml",
            "nested.xml",
            "b.xml",
        ]);
        expect(documents.map((document) => document.items[0]?.attributes.id)).toEqual([
            "FIRST",
            "A",
            "LOWER_A",
            "NESTED",
            "B",
        ]);
    });

    test("does not discover XML outside an explicitly supplied directory", async () => {
        const packagePath = join(directory, "package");
        await mkdir(packagePath);
        await writeFile(join(packagePath, "one.xml"), '<Item type="Identity" />');
        await writeFile(join(directory, "unrelated.xml"), "broken unrelated document");
        expect(await loadAmlDocuments([{ path: packagePath }])).toHaveLength(1);
    });

    test("rejects overlapping inputs instead of importing the same XML twice", async () => {
        const path = join(directory, "one.xml");
        await writeFile(path, "<AML />");
        await expect(loadAmlDocuments([{ path: directory }, { path }])).rejects.toMatchObject({
            code: "DuplicatePackageFile",
            path,
        });
    });

    test("reports missing paths and empty directories", async () => {
        await expect(
            loadAmlDocuments([{ path: join(directory, "missing") }]),
        ).rejects.toBeInstanceOf(PackageFileError);
        await expect(loadAmlDocuments([{ path: directory }])).rejects.toMatchObject({
            code: "EmptyPackageDirectory",
        });
        await expect(loadAmlDocuments([{ path: " " }])).rejects.toMatchObject({
            code: "MissingPackagePath",
        });
    });

    test("rejects symlinks to files and directories", async () => {
        const actual = join(directory, "actual");
        await mkdir(actual);
        await writeFile(join(actual, "data.xml"), "<AML />");
        const link = join(directory, "link");
        await symlink(actual, link);
        await expect(loadAmlDocuments([{ path: link }])).rejects.toMatchObject({
            code: "UnsupportedSymlink",
            path: link,
        });
        await expect(loadAmlDocuments([{ path: directory }])).rejects.toMatchObject({
            code: "UnsupportedSymlink",
            path: link,
        });
    });

    test("rejects invalid UTF-8 instead of silently changing package source", async () => {
        const path = join(directory, "invalid.xml");
        await writeFile(path, new Uint8Array([0xff, 0xfe, 0x00]));
        await expect(loadAmlDocuments([{ path }])).rejects.toMatchObject({
            code: "InvalidPackageEncoding",
            path,
        });
    });
});

test("package folders load XML alongside and inside Import directories", async () => {
    await mkdir(join(directory, "Import"));
    await Bun.write(join(directory, "root.xml"), '<Item type="Identity" id="ROOT" />');
    await Bun.write(join(directory, "Import", "schema.xml"), "<AML />");
    const documents = await loadAmlDocuments([{ path: directory }]);
    expect(documents.map((document) => basename(document.file))).toEqual([
        "schema.xml",
        "root.xml",
    ]);
});

test("folders load unlisted XML without following their import manifest", async () => {
    const exported = join(directory, "exported");

    for (const name of ["Listed", "Unlisted"]) {
        const path = join(exported, name, "Import", "data.xml");
        await Bun.write(path, `<Item type="Identity" id="${name}" />`);
    }

    await Bun.write(join(directory, "outside.xml"), '<Item type="Identity" id="OUTSIDE" />');
    await Bun.write(
        join(exported, "imports.mf"),
        '<imports><package name="Outside" path="../outside.xml" /></imports>',
    );

    const documents = await loadAmlDocuments([{ path: exported }]);
    expect(documents.map((document) => document.items[0]?.attributes.id)).toEqual([
        "Listed",
        "Unlisted",
    ]);
});

test("malformed import manifests do not affect folder loading", async () => {
    await Bun.write(join(directory, "data.xml"), "<AML />");
    await Bun.write(join(directory, "imports.mf"), "This is not a valid manifest.");

    const documents = await loadAmlDocuments([{ path: directory }]);
    expect(documents.map((document) => basename(document.file))).toEqual(["data.xml"]);
});

test("explicit import manifests preserve independent order and place dependencies first", async () => {
    for (const name of ["Feature", "Base", "Other"]) {
        await mkdir(join(directory, name, "Import"), { recursive: true });
        await Bun.write(
            join(directory, name, "Import", "items.xml"),
            `<Item type="Identity" id="${name}" />`,
        );
    }

    await Bun.write(
        join(directory, "imports.mf"),
        `<imports>
    <package name="Feature" path="Feature\\Import"><dependson name="Base" /></package>
    <package name="Base" path="Base\\Import" />
    <package name="Other" path="Other\\Import" />
  </imports>`,
    );
    const documents = await loadAmlDocuments([{ path: join(directory, "imports.mf") }]);
    expect(documents.map((document) => document.items[0]?.attributes.id)).toEqual([
        "Base",
        "Feature",
        "Other",
    ]);
});

test.each([
    ['<package name="A" path="A"><dependson name="B" /></package>', "MISSING_PACKAGE"],
    ['<package name="A" path="A" /><package name="A" path="B" />', "DUPLICATE_PACKAGE"],
    [
        '<package name="A" path="A"><dependson name="B" /></package><package name="B" path="B"><dependson name="A" /></package>',
        "CYCLIC_PACKAGES",
    ],
])("invalid manifest dependencies fail before reading package paths", async (body, code) => {
    const path = join(directory, "imports.mf");
    await Bun.write(path, `<imports>${body}</imports>`);
    await expect(loadAmlDocuments([{ path }])).rejects.toMatchObject({ code });
});
