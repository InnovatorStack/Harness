import { parser as createXmlParser } from "sax";
import type { QualifiedTag, Tag } from "sax";

import { dataBytesMax, dataDepthMax, dataNodesMax } from "../core/limits.js";
import type { SourceLocation } from "../diagnostics/source-location.js";
import type { AmlDocument, AmlElement, AmlText } from "./types.js";

export class AmlParseError extends Error {
    override readonly name = "AmlParseError";

    constructor(
        readonly code: string,
        message: string,
        readonly source: SourceLocation,
        options?: ErrorOptions,
    ) {
        super(`${source.file}:${source.line}:${source.column}: ${message}`, options);
    }
}

interface OpenElement {
    readonly name: string;
    readonly attributes: Map<string, string>;
    readonly children: (AmlElement | AmlText)[];
    readonly childCounts: Map<string, number>;
    readonly source: SourceLocation;
}

export function parseAml(xml: string, file: string): AmlDocument {
    const root = parseXml(xml, file);

    if (root.name !== "AML" && root.name !== "Item") {
        throw new AmlParseError(
            "UnsupportedRoot",
            `Expected an AML or Item root; received '${root.name}'.`,
            root.source,
        );
    }

    const items = root.name === "Item" ? [root] : root.children.filter(isElement);

    return Object.freeze({
        file,
        sha256: new Bun.CryptoHasher("sha256").update(xml).digest("hex"),
        xml,
        items: Object.freeze(items),
    });
}

/** Parse XML with the same source tracking and entity restrictions used for AML. */
export function parseXml(xml: string, file: string): AmlElement {
    return new XmlReader(xml, file).parse();
}

/** The event reader owns one document and one explicit stack of open elements. */
class XmlReader {
    private readonly parser = createXmlParser(true, {
        position: true,
        trim: false,
        normalize: false,
        xmlns: true,
    });
    private readonly lineStarts: readonly number[];
    private readonly stack: OpenElement[] = [];
    private opening: OpenElement | undefined;
    private root: AmlElement | undefined;
    private nodes = 0;

    constructor(
        private readonly xml: string,
        private readonly file: string,
    ) {
        if (xml.length > dataBytesMax) {
            throw new AmlParseError("InvalidXml", "XML exceeds the text limit.", {
                file,
                line: 1,
                column: 1,
                path: "/",
            });
        }

        this.lineStarts = findLineStarts(xml, file);
        this.parser.ENTITIES = { amp: "&", lt: "<", gt: ">", apos: "'", quot: '"' };
        this.parser.onerror = (error) => this.invalidXml(error);
        this.parser.ondoctype = () =>
            this.fail("UnsupportedDoctype", "DOCTYPE declarations are not supported.");
        this.parser.onsgmldeclaration = () =>
            this.fail(
                "UnsupportedDeclaration",
                "Only XML declarations, comments, and CDATA are supported.",
            );
        this.parser.onprocessinginstruction = (instruction) =>
            this.declaration(instruction.name, instruction.body);
        this.parser.onopentagstart = (tag) => this.startElement(tag.name);
        this.parser.onattribute = (attribute) => this.attribute(attribute.name, attribute.value);
        this.parser.onopentag = (tag) => this.openElement(tag);
        this.parser.ontext = (value) => this.appendText("text", value);
        this.parser.oncdata = (value) => this.appendText("cdata", value);
        this.parser.onclosetag = () => this.closeElement();
    }

    parse(): AmlElement {
        validateXmlCharacters(this.xml, this.file, this.lineStarts);
        this.parser.write(this.xml).close();

        if (!this.root) {
            this.fail("MissingRoot", "The document does not contain an AML or Item root.");
        }

        return this.root;
    }

    private source(): SourceLocation {
        return (
            this.opening?.source ??
            this.stack.at(-1)?.source ??
            locate(this.file, this.lineStarts, Math.max(0, this.parser.position - 1), "/")
        );
    }

    private fail(code: string, message: string): never {
        throw new AmlParseError(code, message, this.source());
    }

    private invalidXml(error: Error): never {
        const source = locate(
            this.file,
            this.lineStarts,
            Math.max(0, this.parser.position - 1),
            this.source().path,
        );

        throw new AmlParseError("InvalidXml", error.message, source, { cause: error });
    }

    private declaration(name: string, body: string): void {
        if (name !== "xml") {
            this.fail(
                "UnsupportedProcessingInstruction",
                `Processing instruction '${name}' is not supported.`,
            );
        }

        const position = this.xml.startsWith("\uFEFF") ? 2 : 1;
        const pattern =
            /^version\s*=\s*(['"])1\.0\1(?:\s+encoding\s*=\s*(['"])[A-Za-z][A-Za-z0-9._-]*\2)?(?:\s+standalone\s*=\s*(['"])(?:yes|no)\3)?\s*$/;

        if (this.parser.startTagPosition !== position || !pattern.test(body)) {
            this.fail(
                "InvalidXmlDeclaration",
                "A valid XML 1.0 declaration may appear only at the start of the document.",
            );
        }
    }

    private startElement(name: string): void {
        this.nodes += 1;

        if (this.nodes > dataNodesMax || this.stack.length >= dataDepthMax) {
            this.fail("InvalidXml", "XML exceeds its node or nesting limit.");
        }

        const parent = this.stack.at(-1);
        const index = (parent?.childCounts.get(name) ?? 0) + 1;
        parent?.childCounts.set(name, index);
        const path = `${parent?.source.path ?? ""}/${name}[${index}]`;
        this.opening = {
            name,
            attributes: new Map(),
            children: [],
            childCounts: new Map(),
            source: locate(this.file, this.lineStarts, this.parser.startTagPosition - 1, path),
        };
    }

    private attribute(name: string, value: string): void {
        if (!this.opening) {
            this.fail("InvalidXml", "Attribute appeared outside an opening element.");
        }

        if (this.opening.attributes.has(name)) {
            this.fail("DuplicateAttribute", `Attribute '${name}' is repeated.`);
        }

        this.opening.attributes.set(name, value);
    }

    private openElement(tag: Tag | QualifiedTag): void {
        if (!this.opening) {
            this.fail("InvalidXml", "Opening element is missing its source information.");
        }

        const element = this.opening;
        const parent = this.stack.at(-1);
        const expandedAttributes = new Set<string>();

        for (const input of Object.values(tag.attributes)) {
            const attribute: unknown = input;

            if (
                typeof attribute !== "object" ||
                attribute === null ||
                !("uri" in attribute) ||
                !("local" in attribute) ||
                !("name" in attribute) ||
                typeof attribute.uri !== "string" ||
                typeof attribute.local !== "string" ||
                typeof attribute.name !== "string"
            ) {
                continue;
            }

            const expandedName = `${attribute.uri}\u0000${attribute.local}`;

            if (expandedAttributes.has(expandedName)) {
                this.fail(
                    "DuplicateAttribute",
                    `Attribute '${attribute.name}' repeats an expanded XML name.`,
                );
            }

            expandedAttributes.add(expandedName);
        }

        if (!parent && this.root) {
            this.fail("InvalidXml", "An AML document must have one root element.");
        }

        if (parent?.name === "AML" && element.name !== "Item") {
            this.fail(
                "UnsupportedAmlElement",
                `AML may contain only Item elements; received '${element.name}'.`,
            );
        }

        if (element.name === "Item" && !element.attributes.get("type")?.trim()) {
            this.fail("MissingItemType", "Every Item must declare its type attribute.");
        }

        this.stack.push(element);
        this.opening = undefined;
    }

    private appendText(kind: AmlText["kind"], value: string): void {
        const element = this.stack.at(-1);

        if (!element) {
            if (value.trim()) {
                this.fail("InvalidXml", "Text is not allowed outside the root element.");
            }

            return;
        }

        if (element.name === "AML" && value.trim()) {
            this.fail("UnsupportedAmlText", "AML may contain only Item elements and whitespace.");
        }

        element.children.push(Object.freeze({ kind, value }));
    }

    private closeElement(): void {
        const element = this.stack.pop();

        if (!element) {
            this.fail("InvalidXml", "Closing element has no matching opening element.");
        }

        const completed: AmlElement = Object.freeze({
            kind: "element",
            name: element.name,
            attributes: Object.freeze(Object.fromEntries(element.attributes)),
            children: Object.freeze(element.children),
            source: Object.freeze(element.source),
        });
        const parent = this.stack.at(-1);

        if (parent) {
            parent.children.push(completed);
        } else {
            this.root = completed;
        }
    }
}

function isElement(node: AmlElement | AmlText): node is AmlElement {
    return node.kind === "element";
}

function validateXmlCharacters(xml: string, file: string, lineStarts: readonly number[]): void {
    for (let index = 0; index < xml.length; index += 1) {
        const code = xml.codePointAt(index) ?? 0;
        const valid =
            code === 0x09 ||
            code === 0x0a ||
            code === 0x0d ||
            (code >= 0x20 && code <= 0xd7_ff) ||
            (code >= 0xe0_00 && code <= 0xff_fd) ||
            (code >= 0x1_00_00 && code <= 0x10_ff_ff);

        if (!valid) {
            throw new AmlParseError(
                "InvalidXml",
                "The source contains a character that is invalid in XML 1.0.",
                locate(file, lineStarts, index, "/"),
            );
        }

        if (code > 0xff_ff) {
            index += 1;
        }
    }
}

function findLineStarts(xml: string, file: string): readonly number[] {
    const starts = [0];

    for (let index = 0; index < xml.length; index += 1) {
        if (starts.length > dataNodesMax) {
            throw new AmlParseError("InvalidXml", "XML exceeds the line-count limit.", {
                file,
                line: starts.length,
                column: 1,
                path: "/",
            });
        }

        if (xml[index] === "\r") {
            if (xml[index + 1] === "\n") {
                index += 1;
            }

            starts.push(index + 1);
        } else if (xml[index] === "\n") {
            starts.push(index + 1);
        }
    }

    return starts;
}

function locate(
    file: string,
    lineStarts: readonly number[],
    offset: number,
    path: string,
): SourceLocation {
    let low = 0;
    let high = lineStarts.length;

    while (low + 1 < high) {
        const middle = Math.floor((low + high) / 2);

        if ((lineStarts[middle] ?? 0) <= offset) {
            low = middle;
        } else {
            high = middle;
        }
    }

    return {
        file,
        line: low + 1,
        column: offset - (lineStarts[low] ?? 0) + 1,
        path,
    };
}
