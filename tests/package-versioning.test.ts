import { expect, test } from "bun:test";

import { createEngine } from "../src/engine.js";
import { importPackageDocuments } from "../src/packages/module.js";
import { parseAml } from "../src/packages/parser.js";

test("ordinary versionable exports receive initial generation fields and remain queryable", async () => {
    using engine = createEngine();
    const document = parseAml(
        `<AML>
      <Item type="Method" action="add" id="EXPORTED_METHOD">
        <name>ExportedMethod</name>
        <method_type>C#</method_type>
        <method_code>return this;</method_code>
      </Item>
    </AML>`,
        "methods.xml",
    );

    engine.runtime.executeSync(importPackageDocuments, [document]);
    const result = await engine.applyAML(
        '<Item type="Method" action="get"><name>ExportedMethod</name></Item>',
    );

    expect(result.isError()).toBe(false);
    expect(result.getID()).toBe("EXPORTED_METHOD");
    expect(engine.storage.getCatalogEntry("Method", result.getID())?.properties).toMatchObject({
        config_id: "EXPORTED_METHOD",
        generation: 1,
        is_current: 1,
        method_code: "return this;",
    });
    expect(engine.storage.listDocuments().find((entry) => entry.path === document.file)?.xml).toBe(
        document.xml,
    );
});

test("imported generations and later patches retain explicit version identities", async () => {
    using engine = createEngine();
    engine.runtime.executeSync(importPackageDocuments, [
        parseAml(
            `<AML>
        <Item type="Method" action="add" id="HISTORICAL_METHOD">
          <name>VersionedMethod</name><method_type>C#</method_type>
          <config_id>METHOD_FAMILY</config_id><generation>6</generation><is_current>0</is_current>
        </Item>
        <Item type="Method" action="add" id="CURRENT_METHOD">
          <name>VersionedMethod</name><method_type>C#</method_type>
          <config_id>METHOD_FAMILY</config_id><generation>7</generation><is_current>1</is_current>
        </Item>
      </AML>`,
            "generations.xml",
        ),
    ]);
    engine.runtime.executeSync(importPackageDocuments, [
        parseAml(
            '<Item type="Method" action="edit" id="CURRENT_METHOD"><method_code>return this;</method_code></Item>',
            "patch.xml",
        ),
    ]);

    const current = await engine.applyAML(
        '<Item type="Method" action="get"><name>VersionedMethod</name></Item>',
    );
    expect(current.getID()).toBe("CURRENT_METHOD");
    expect(engine.storage.getItem("Method", "CURRENT_METHOD")?.properties).toMatchObject({
        config_id: "METHOD_FAMILY",
        generation: 7,
        is_current: 1,
        method_code: "return this;",
    });
    expect(engine.storage.getItem("Method", "HISTORICAL_METHOD")?.properties).toMatchObject({
        config_id: "METHOD_FAMILY",
        generation: 6,
        is_current: 0,
    });
});
