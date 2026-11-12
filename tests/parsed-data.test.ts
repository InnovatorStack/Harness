import { expect, test } from "bun:test";

import { assertDataTree, freezeData, getOwn, parseFrozenJson } from "../src/core/data.js";
import { dataDepthMax, dataNodesMax } from "../src/core/limits.js";
import { decodePayload, object } from "../src/items/codec.js";
import { readMessages } from "../src/methods/csharp/protocol.js";

test("owned JSON is bounded and immutable while decoded Items remain detached", () => {
    const parsed = parseFrozenJson(`{
        "items": [{"type":"Record", "attributes":{}, "properties":{"name":"Original"},
        "propertyItems":{}, "relationships":[]}], "__proto__":{"owned":true}
    }`);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(() => assertDataTree(parsed)).not.toThrow();
    const first = decodePayload(parsed);
    const second = decodePayload(parsed);

    if (!first.items[0] || !object(parsed)) {
        throw new Error("Expected a parsed Item payload.");
    }

    first.items[0].properties.name = "Changed";
    expect(second.items[0]?.properties.name).toBe("Original");
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(getOwn(parsed, "__proto__")).toEqual({ owned: true });
    expect(Object.isFrozen(getOwn(parsed, "__proto__"))).toBe(true);
});

test("JSON fast paths retain depth, node, scalar and restrictive validation boundaries", () => {
    const deep = `${"[".repeat(dataDepthMax + 1)}0${"]".repeat(dataDepthMax + 1)}`;
    expect(() => parseFrozenJson(deep)).toThrow("nesting limit");
    expect(() => parseFrozenJson(`[${"0,".repeat(dataNodesMax)}0]`)).toThrow("node limit");
    expect(() => parseFrozenJson('{"number":1e400}')).toThrow("non-serializable");
    expect(() => parseFrozenJson('{"unfinished":')).toThrow();
    expect(() =>
        assertDataTree(parseFrozenJson("[1]"), {
            allowArrays: false,
            allowUndefined: true,
        }),
    ).toThrow("arrays");
    expect(() =>
        assertDataTree(freezeData({ missing: undefined }), {
            allowArrays: true,
            allowUndefined: false,
        }),
    ).toThrow("undefined");
});

test("managed frames preserve fragmented UTF-8 and validate each complete message", async () => {
    const encoded = new TextEncoder().encode('{"kind":"result","id":"1","text":"ø😀"}\n');
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const byte of encoded) {
                controller.enqueue(new Uint8Array([byte]));
            }

            controller.close();
        },
    });
    const messages: Record<string, unknown>[] = [];
    await readMessages(stream, (message) => {
        messages.push(message);
    });
    expect(messages).toEqual([{ kind: "result", id: "1", text: "ø😀" }]);
    expect(Object.isFrozen(messages[0])).toBe(true);
});
