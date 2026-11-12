import { itemNodeFromElement } from "../../src/items/xml.js";
import { childElements, textContent } from "../../src/packages/elements.js";
import { parseXml } from "../../src/packages/parser.js";
import { projectPayload } from "./projection.js";
import type { EventObservation } from "./types.js";

export const nativeEventPrefix = "HARNESS_REFERENCE_EVENT|";
const logCharactersMax = 8 * 1024 * 1024;
const eventCharactersMax = 256 * 1024;

/** Decode explicitly captured log lines offline. No connection or server execution is involved. */
export function readNativeEvents(
    log: string,
    bindings: ReadonlyMap<string, string>,
): readonly EventObservation[] {
    if (log.length > logCharactersMax) {
        throw new RangeError("The native event log exceeds its input limit.");
    }

    const events: EventObservation[] = [];

    for (const line of log.split(/\r?\n/u)) {
        if (!line.startsWith(nativeEventPrefix)) {
            continue;
        }

        const separator = line.indexOf("|", nativeEventPrefix.length);
        const method = line.slice(nativeEventPrefix.length, separator);
        const event = bindings.get(method);
        const encoded = line.slice(separator + 1);

        if (
            !event ||
            separator === -1 ||
            encoded.length === 0 ||
            encoded.length > eventCharactersMax ||
            events.length >= 1000
        ) {
            throw new TypeError(
                "Native event records must contain a known Method and bounded AML.",
            );
        }

        const bytes = Uint8Array.from(atob(encoded), byteFromCharacter);
        const xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        const root = parseXml(xml, "<native-event>");

        if (!["AML", "Result", "Item"].includes(root.name) || textContent(root).trim()) {
            throw new TypeError("A native event requires an Item, AML or Result envelope.");
        }

        const elements = root.name === "Item" ? [root] : childElements(root);
        const items = elements.map(itemNodeFromElement);

        if (items.length === 0) {
            throw new TypeError("A native event must retain its Item context.");
        }

        events.push({ method, event, context: projectPayload({ items }) });
    }

    return events;
}

function byteFromCharacter(character: string): number {
    const byte = character.codePointAt(0);

    if (byte === undefined || byte > 255) {
        throw new TypeError("A decoded Base64 character must represent one byte.");
    }

    return byte;
}
