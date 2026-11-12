export interface SourceLocation {
    readonly file: string;
    readonly line: number;
    readonly column: number;
    readonly path: string;
}
