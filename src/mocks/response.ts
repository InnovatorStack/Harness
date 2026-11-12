import { extname, resolve } from "node:path";

import { assertDataTree } from "../core/data.js";
import { readTextFile } from "../core/files.js";
import { object } from "../items/codec.js";
import { Item } from "../items/item.js";
import { parseItems } from "../items/xml.js";
import type { MockResponse, JsonValue } from "./types.js";

export interface PreparedResponse {
    readonly item: Item;
    readonly file?: string;
    readonly hash: string;
}

export async function prepareResponse(
    response: string | MockResponse,
    directory: string,
): Promise<PreparedResponse> {
    if (typeof response !== "string") {
        const item = responseItem(response);

        return { item, hash: hash(JSON.stringify(item.payload)) };
    }

    const file = resolve(directory, response);
    const text = await readTextFile(file);
    const extension = extname(file).toLowerCase();
    let item: Item;

    if (extension === ".json") {
        item = jsonResult(JSON.parse(text.replace(/^\uFEFF/u, "")));
    } else if (extension === ".xml" || extension === ".aml") {
        item = amlResult(text);
    } else if (extension === ".txt") {
        item = new Item({ items: [], result: text });
    } else {
        throw new Error(`Mock response '${file}' must be JSON, AML/XML, or text.`);
    }

    return { item, file, hash: hash(text) };
}

export function parseResponse(value: unknown): string | MockResponse {
    if (typeof value === "string" && value.trim().length > 0) {
        return value;
    }

    if (value instanceof Item) {
        return value;
    }

    if (!object(value)) {
        throw new Error("A mock response must be a file, Item, or json/text/aml/error response.");
    }

    const keys = Object.keys(value);

    if (keys.length === 1 && "json" in value) {
        assertJson(value.json);

        return { json: value.json };
    }

    if (keys.length === 1 && typeof value.text === "string") {
        return { text: value.text };
    }

    if (keys.length === 1 && typeof value.aml === "string") {
        return { aml: value.aml };
    }

    if (
        typeof value.error === "string" &&
        (value.code === undefined || typeof value.code === "string") &&
        keys.every((key) => key === "error" || key === "code")
    ) {
        return { error: value.error, ...(value.code === undefined ? {} : { code: value.code }) };
    }

    throw new Error("A mock response must contain exactly one of json, text, aml, or error.");
}

function responseItem(response: MockResponse): Item {
    if (response instanceof Item) {
        return response.clone();
    }

    if ("json" in response) {
        return jsonResult(response.json);
    }

    if ("text" in response) {
        return new Item({ items: [], result: response.text });
    }

    if ("aml" in response) {
        return amlResult(response.aml);
    }

    return Item.error(response.error, response.code);
}

function jsonResult(value: unknown): Item {
    assertJson(value);

    return new Item({ items: [], result: JSON.stringify(value) });
}

function assertJson(value: unknown): asserts value is JsonValue {
    try {
        assertDataTree(value, { allowArrays: true, allowUndefined: false });
    } catch (error) {
        throw new Error("Mock JSON must contain only finite plain JSON values without cycles.", {
            cause: error,
        });
    }
}

function amlResult(xml: string): Item {
    const items = parseItems(xml);

    return new Item({ items: items.flatMap((item) => item.payload.items) });
}

function hash(text: string): string {
    return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}
