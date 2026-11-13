import { expect, test } from "bun:test";
import { mkdir, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";

import {
    checkCompatibility,
    CompilationStatus,
    createHarness,
    ExecutionMode,
    FailurePoint,
    MethodSourceKind,
} from "../src/index.js";
import {
    methodBody,
    methodCall,
    methodProject,
    writeWorkingMethod,
} from "./helpers/method-files.js";

test("a named file replaces package code without changing package bytes", async () => {
    await using project = await methodProject();
    const original = await Bun.file(project.packageFile).text();
    const code = methodBody("Local");
    await Bun.write(project.file, code);
    using world = await createHarness({ cwd: project.cwd });

    expect((await world.callMethod("WorkingMethod")).getResult()).toBe("Local");
    const call = methodCall(world);
    expect(call.definition?.id).toBe("SOURCE_METHOD");
    expect(call.source?.file).toBe(project.file);
    expect(call.sourceHash).toBe(new Bun.CryptoHasher("sha256").update(code).digest("hex"));
    expect(call.methodSource).toMatchObject({
        kind: MethodSourceKind.LocalFile,
        configuredFile: project.file,
        fallback: false,
        packageSource: { file: project.packageFile },
    });
    expect(call.executed).toBe(true);
    expect(await Bun.file(project.packageFile).text()).toBe(original);
});

test("nested Methods and imported hooks resolve the same working file", async () => {
    await using project = await methodProject();
    await Bun.write(project.file, methodBody("Local"));
    using world = await createHarness({ cwd: project.cwd });

    expect((await world.callMethod("Caller")).getResult()).toBe("Local");
    expect(methodCall(world).source?.file).toBe(project.file);
    const record = await world.getOne("SourceRecord", { name: "Before" });
    await world.update(record, { name: "Requested" });
    expect(methodCall(world).methodSource?.kind).toBe(MethodSourceKind.LocalFile);
    expect((await world.getOne("SourceRecord", { id: record.id })).properties.name).toBe("Local");
});

test("a missing file uses package source and records the fallback", async () => {
    await using project = await methodProject();
    using world = await createHarness({ cwd: project.cwd });

    expect((await world.callMethod("WorkingMethod")).getResult()).toBe("Package");
    expect(methodCall(world).source?.file).toBe(project.packageFile);
    expect(methodCall(world).methodSource).toMatchObject({
        kind: MethodSourceKind.Package,
        configuredFile: project.file,
        fallback: true,
    });
});

test("local Methods need no package definition; missing implementations fail only when used", async () => {
    await using project = await methodProject();
    await Bun.write(project.file, methodBody("Standalone"));
    using world = await createHarness({
        cwd: project.cwd,
        methods: { Standalone: "../working/different-name.cs", Missing: "../absent.cs" },
    });

    expect((await world.callMethod("Standalone")).getResult()).toBe("Standalone");
    expect(methodCall(world, "Standalone").methodSource?.packageSource).toBeUndefined();
    await expect(world.callMethod("Missing")).rejects.toMatchObject({ code: "MethodResolution" });
    expect((await world.callMethod("Caller")).getResult()).toBe("Standalone");
});

test("invalid local C# fails at its source file instead of executing the package", async () => {
    await using project = await methodProject();
    await Bun.write(project.file, "this is not valid C# source;");
    using world = await createHarness({ cwd: project.cwd });

    await expect(world.callMethod("WorkingMethod")).rejects.toMatchObject({
        code: "MethodCompilationFailed",
    });
    expect(methodCall(world).source?.file).toBe(project.file);
    expect(methodCall(world).methodSource?.fallback).toBe(false);
    expect(methodCall(world).executed).toBe(false);
});

test("runtime failures from a working file roll back instead of using package code", async () => {
    await using project = await methodProject();
    await Bun.write(
        project.file,
        `var inn = this.getInnovator();
var record = inn.newItem("SourceRecord", "add");
record.setProperty("name", "Must roll back");
record.apply();
throw new System.InvalidOperationException("Working source failed");`,
    );
    using world = await createHarness({ cwd: project.cwd });
    const before = world.state.get("SourceRecord");

    await expect(world.callMethod("WorkingMethod")).rejects.toThrow("Working source failed");
    expect(world.state.get("SourceRecord")).toEqual(before);
    expect(methodCall(world).methodSource?.fallback).toBe(false);
});

test.each(["directory", "invalid UTF-8"])(
    "an existing %s source fails without package fallback",
    async (kind) => {
        await using project = await methodProject();

        if (kind === "directory") {
            await mkdir(project.file, { recursive: true });
        }

        if (kind === "invalid UTF-8") {
            await Bun.write(project.file, new Uint8Array([0xff, 0xfe, 0xff]));
        }

        using world = await createHarness({ cwd: project.cwd });
        await expect(world.callMethod("WorkingMethod")).rejects.toMatchObject({
            code: "MethodSourceReadFailed",
            source: { file: project.file },
        });
    },
);

test("explicit mocks retain precedence and do not compile broken working source", async () => {
    await using project = await methodProject();
    await Bun.write(project.file, "not valid C#;");
    using world = await createHarness({
        cwd: project.cwd,
        mocks: [{ method: "WorkingMethod", response: { text: "Mocked" } }],
    });

    expect((await world.callMethod("WorkingMethod")).getResult()).toBe("Mocked");
    expect(methodCall(world).mode).toBe(ExecutionMode.Mocked);
    expect(methodCall(world).executed).toBe(false);
});

test("equal-size file edits invalidate compilation while an existing world stays isolated", async () => {
    await using project = await methodProject();
    await Bun.write(project.file, methodBody("First"));
    const timestamps = await stat(project.file);
    using first = await createHarness({ cwd: project.cwd });
    expect((await first.callMethod("WorkingMethod")).getResult()).toBe("First");
    const hash = methodCall(first).sourceHash;
    await Bun.write(project.file, methodBody("Later"));
    await utimes(project.file, timestamps.atime, timestamps.mtime);
    using second = await createHarness({ cwd: project.cwd });

    expect((await second.callMethod("WorkingMethod")).getResult()).toBe("Later");
    expect(methodCall(second).sourceHash).not.toBe(hash);
    expect((await first.callMethod("WorkingMethod")).getResult()).toBe("First");
    first.reset();
    expect((await first.callMethod("WorkingMethod")).getResult()).toBe("First");
});

test("cached package setup follows missing, created, deleted and recreated source files", async () => {
    await using project = await methodProject();

    for (const expected of ["Package", "Local", "Package", "Other"]) {
        await writeWorkingMethod(project.file, expected === "Package" ? undefined : expected);

        using world = await createHarness({ cwd: project.cwd });
        expect((await world.callMethod("WorkingMethod")).getResult()).toBe(expected);
        expect(methodCall(world).methodSource?.fallback).toBe(expected === "Package");
    }
});

test("per-world mappings override names case-insensitively and preserve unrelated mappings", async () => {
    await using project = await methodProject();
    await Bun.write(project.file, methodBody("Shared"));
    await Bun.write(join(project.cwd, "working", "override.cs"), methodBody("Override"));
    await Bun.write(
        join(project.cwd, ".harness", "config.ts"),
        `export default {
    methods: {
        WorkingMethod: "../working/different-name.cs",
        SharedOnly: "../working/different-name.cs",
    },
};`,
    );
    using world = await createHarness({
        cwd: project.cwd,
        methods: { workingmethod: "../working/override.cs", Extra: "../working/different-name.cs" },
    });

    expect((await world.callMethod("WorkingMethod")).getResult()).toBe("Override");
    expect((await world.callMethod("Extra")).getResult()).toBe("Shared");
    expect((await world.callMethod("SharedOnly")).getResult()).toBe("Shared");
    using original = await createHarness({ cwd: project.cwd });
    expect((await original.callMethod("WorkingMethod")).getResult()).toBe("Shared");
    using cleared = await createHarness({ cwd: project.cwd, methods: {} });
    expect((await cleared.callMethod("WorkingMethod")).getResult()).toBe("Package");
});

test("compatibility inspects the effective file and keeps original package declarations", async () => {
    await using project = await methodProject();
    await Bun.write(project.file, methodBody("Local"));
    const report = await checkCompatibility({ cwd: project.cwd, compile: true });
    const method = report.methods.find((value) => value.declaration.name === "WorkingMethod");

    expect(report.packages.canImport).toBe(true);
    expect(method?.declaration.source.file).toBe(project.packageFile);
    expect(method?.definition?.source.file).toBe(project.file);
    expect(method?.definition?.methodSource?.kind).toBe(MethodSourceKind.LocalFile);
    expect(method?.compilation.status).toBe(CompilationStatus.Compiled);
    expect(method?.executed).toBe(false);
});

test.each(
    [
        null,
        [],
        "source.cs",
        { "": "file.cs" },
        { Name: "" },
        { Name: 3 },
        { Name: "a.cs", name: "b.cs" },
    ].map((methods) => ({ methods })),
)("invalid mappings are rejected before world setup: %j", async ({ methods }) => {
    await using project = await methodProject();
    await Bun.write(
        join(project.cwd, ".harness", "config.ts"),
        `export default { methods: ${JSON.stringify(methods)} };`,
    );

    await expect(createHarness({ cwd: project.cwd })).rejects.toThrow();
});

test("a missing nested implementation fails through the ordinary dispatcher", async () => {
    await using project = await methodProject();
    await Bun.write(project.file, `return this.getInnovator().applyMethod("AbsentMethod", "");`);
    using world = await createHarness({
        cwd: project.cwd,
        methods: { AbsentMethod: "../missing.cs" },
    });

    await expect(world.callMethod("Caller")).rejects.toMatchObject({ code: "MethodResolution" });
});

test("mapped source cannot bypass imported Method execution permissions", async () => {
    await using project = await methodProject();
    const xml = await Bun.file(project.packageFile).text();
    await Bun.write(
        project.packageFile,
        xml.replace(
            "<name>WorkingMethod</name>",
            "<name>WorkingMethod</name><execution_allowed_to>2618D6F5A90949BAA7E920D1B04C7EE1</execution_allowed_to>",
        ),
    );
    await Bun.write(project.file, methodBody("Local"));
    using world = await createHarness({ cwd: project.cwd });

    await expect(world.callMethod("WorkingMethod")).rejects.toMatchObject({
        code: "AuthorizationRequired",
    });
    expect(methodCall(world).executed).toBe(false);
});

test("compatibility includes standalone source and diagnoses a missing implementation", async () => {
    await using project = await methodProject();
    await Bun.write(project.file, methodBody("Local"));
    const report = await checkCompatibility({
        cwd: project.cwd,
        methods: { Standalone: "../working/different-name.cs", Absent: "../missing.cs" },
    });
    const local = report.methods.find((value) => value.declaration.name === "Standalone");
    const missing = report.methods.find((value) => value.declaration.name === "Absent");

    expect(local?.definition?.source.file).toBe(project.file);
    expect(local?.definition?.methodSource?.kind).toBe(MethodSourceKind.LocalFile);
    expect(missing?.issues.some((issue) => issue.causeCode === "MethodResolution")).toBe(true);
});

test("compatibility uses changed file hashes and never compiles a missing file in place of its package", async () => {
    await using project = await methodProject();
    await Bun.write(project.file, methodBody("First"));
    using world = await createHarness({ cwd: project.cwd });
    await world.callMethod("WorkingMethod");
    const first = methodCall(world).sourceHash;
    await Bun.write(project.file, methodBody("Later"));
    const changed = await checkCompatibility({ cwd: project.cwd, executions: world.executions });
    const local = changed.methods.find((value) => value.declaration.name === "WorkingMethod");

    expect(local?.definition?.hash).not.toBe(first);
    expect(local?.executed).toBe(false);
    await rm(project.file);
    const fallback = await checkCompatibility({ cwd: project.cwd, compile: true });
    const packaged = fallback.methods.find((value) => value.declaration.name === "WorkingMethod");
    expect(packaged?.definition?.methodSource?.fallback).toBe(true);
    expect(packaged?.definition?.source.file).toBe(project.packageFile);
    expect(packaged?.compilation.status).toBe(CompilationStatus.Compiled);
});

test("disk setup images do not retain a previous process's working Method body", async () => {
    await using project = await methodProject();
    const entry = new URL("../src/index.ts", import.meta.url).href;
    const script = join(project.cwd, "run.ts");
    await Bun.write(
        script,
        `import { createHarness } from ${JSON.stringify(entry)};
using world = await createHarness({ cwd: ${JSON.stringify(project.cwd)} });
console.log((await world.callMethod("WorkingMethod")).getResult());`,
    );

    for (const value of ["First", "Later", "Package"]) {
        await writeWorkingMethod(project.file, value === "Package" ? undefined : value);

        const child = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "pipe" });
        const [code, output, errors] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
        ]);
        expect(errors).toBe("");
        expect(code).toBe(0);
        expect(output.trim()).toBe(value);
    }
});

test("working files retain native CSharpInOut templates", async () => {
    await using project = await methodProject();
    await Bun.write(
        project.file,
        `// MethodTemplateName = CSharpInOut;
outDom.LoadXml("<Result>InOut</Result>");`,
    );
    using world = await createHarness({ cwd: project.cwd });

    expect((await world.callMethod("WorkingMethod")).getResult()).toBe("InOut");
    expect(methodCall(world).methodSource?.kind).toBe(MethodSourceKind.LocalFile);
});

test("a UTF-8 BOM and CRLF source body execute from the original file", async () => {
    await using project = await methodProject();
    await Bun.write(project.file, `\uFEFF${methodBody("Unicode").replaceAll("\n", "\r\n")}`);
    using world = await createHarness({ cwd: project.cwd });

    expect((await world.callMethod("WorkingMethod")).getResult()).toBe("Unicode");
    expect(methodCall(world).source?.line).toBe(1);
});

test("failure injection retains the source that actually executed", async () => {
    await using project = await methodProject();
    await Bun.write(project.file, methodBody("Local"));
    using world = await createHarness({ cwd: project.cwd });
    using failure = world.injectFailure({
        method: "WorkingMethod",
        at: FailurePoint.AfterCall,
        error: new Error("After local source"),
    });

    await expect(world.callMethod("WorkingMethod")).rejects.toThrow("After local source");
    expect(failure.triggered).toBe(true);
    expect(methodCall(world).source?.file).toBe(project.file);
    expect(methodCall(world).sourceHash).toBe(
        new Bun.CryptoHasher("sha256").update(methodBody("Local")).digest("hex"),
    );
    expect(methodCall(world).executed).toBe(true);
});

test("source mappings also apply when custom authorization disables setup snapshots", async () => {
    await using project = await methodProject();
    await Bun.write(project.file, methodBody("Uncached"));
    const authorized: string[] = [];
    using world = await createHarness({
        cwd: project.cwd,

        authorization: (request) => {
            authorized.push(request.kind);
        },
    });

    expect((await world.callMethod("WorkingMethod")).getResult()).toBe("Uncached");
    expect(authorized).toEqual(["method"]);
    expect(methodCall(world).source?.file).toBe(project.file);
});

test.each(["new Map()", "new Date()"])(
    "a %s is not silently accepted as an empty mapping",
    async (value) => {
        await using project = await methodProject();
        await Bun.write(
            join(project.cwd, ".harness", "config.ts"),
            `export default { methods: ${value} };`,
        );

        await expect(createHarness({ cwd: project.cwd })).rejects.toThrow("plain object");
    },
);
