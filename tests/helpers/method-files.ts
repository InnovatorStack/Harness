import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ExecutionKind } from "../../src/index.js";
import type { ExecutionCall, Harness } from "../../src/index.js";

export function methodBody(value: string): string {
    return `if (this.getType() == "SourceRecord") {
    this.setProperty("name", "${value}");
    return this;
}
return this.getInnovator().newResult("${value}");`;
}

export async function writeWorkingMethod(file: string, value: string | undefined): Promise<void> {
    if (value === undefined) {
        await rm(file, { force: true });

        return;
    }

    await Bun.write(file, methodBody(value));
}

export async function methodProject() {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "harness-method-files-")));
    const file = join(cwd, "working", "different-name.cs");
    const packageFile = join(cwd, ".harness", "packages", "methods.xml");
    await Bun.write(
        packageFile,
        `<AML>
<Item type="ItemType" action="add" id="SOURCE_RECORD"><name>SourceRecord</name>
<Relationships>
<Item type="Property" action="add"><name>name</name><data_type>string</data_type></Item>
<Item type="Server Event" action="add"><related_id>SOURCE_METHOD</related_id>
<server_event>onBeforeUpdate</server_event><sort_order>10</sort_order></Item>
</Relationships></Item>
<Item type="Method" action="add" id="SOURCE_METHOD"><name>WorkingMethod</name>
<method_type>C#</method_type><method_code><![CDATA[${methodBody("Package")}]]></method_code></Item>
<Item type="Method" action="add" id="SOURCE_CALLER"><name>Caller</name>
<method_type>C#</method_type><method_code><![CDATA[
return this.getInnovator().applyMethod("WorkingMethod", "");
]]></method_code></Item>
</AML>`,
    );
    await Bun.write(
        join(cwd, ".harness", "config.ts"),
        `export default {
    methods: { WorkingMethod: "../working/different-name.cs" },
};`,
    );
    await Bun.write(
        join(cwd, ".harness", "fixtures.ts"),
        `export default {
    SourceRecord: [{ name: "Before" }],
};`,
    );

    return {
        cwd,
        file,
        packageFile,

        async [Symbol.asyncDispose]() {
            await rm(cwd, { recursive: true, force: true });
        },
    };
}

export function methodCall(world: Harness, name = "WorkingMethod"): ExecutionCall {
    const pending = [...(world.executions.at(-1)?.calls ?? [])];

    while (pending.length > 0) {
        const call = pending.pop();

        if (!call) {
            throw new Error("A pending execution call must exist.");
        }

        if (call.kind === ExecutionKind.Method && call.name === name) {
            return call;
        }

        pending.push(...call.children);
    }

    throw new Error(`No completed Method call '${name}'.`);
}
