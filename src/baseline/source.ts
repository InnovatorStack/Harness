import type { SourceLocation } from "../diagnostics/source-location.js";

export const baselineSourceFile = "<innovator-harness:baseline-v1>";

export function isBaselineSource(source: SourceLocation | undefined): boolean {
    return source?.file === baselineSourceFile;
}

export function baselineSource(type: string, id: string): SourceLocation {
    return {
        file: baselineSourceFile,
        line: 1,
        column: 1,
        path: `/${type}/${id}`,
    };
}
