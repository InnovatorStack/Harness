import type { SourceLocation } from "../diagnostics/source-location.js";

export interface AmlText {
    readonly kind: "text" | "cdata";
    readonly value: string;
}

export interface AmlElement {
    readonly kind: "element";
    readonly name: string;
    readonly attributes: Readonly<Record<string, string>>;
    readonly children: readonly (AmlElement | AmlText)[];
    readonly source: SourceLocation;
}

export interface AmlDocument {
    readonly file: string;
    readonly sha256: string;
    readonly xml: string;
    readonly items: readonly AmlElement[];
}

export interface PackageSource {
    readonly path: string;
}
