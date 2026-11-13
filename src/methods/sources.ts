import type { SourceLocation } from "../diagnostics/source-location.js";

export enum MethodSourceKind {
    LocalFile = "LOCAL_FILE",
    Package = "PACKAGE",
}

export interface MethodSourceResolution {
    readonly kind: MethodSourceKind;
    readonly configuredFile: string;
    readonly fallback: boolean;
    readonly packageSource?: SourceLocation;
}

interface MethodFileIdentity {
    readonly name: string;
    readonly file: string;
}

/** File contents and failures belong to one world, independently of cached package data. */
export type MethodFile = MethodFileIdentity &
    ({ readonly code: string } | { readonly missing: true } | { readonly error: Error });

export function methodFileLocation(input: MethodFileIdentity): SourceLocation {
    return Object.freeze({ file: input.file, line: 1, column: 1, path: "/method_code" });
}
