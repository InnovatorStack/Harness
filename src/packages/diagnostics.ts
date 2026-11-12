import type { SourceLocation } from "../diagnostics/source-location.js";
import type { AmlElement } from "./types.js";

export interface PackageReference {
    readonly type: string;
    readonly id?: string;
    readonly name?: string;
    readonly selector?: AmlElement;
}

interface PackageErrorOptions extends ErrorOptions {
    readonly relatedSources?: readonly SourceLocation[];
    readonly reference?: PackageReference;
}

export class PackageImportError extends Error {
    readonly relatedSources: readonly SourceLocation[];
    readonly reference?: PackageReference;

    constructor(
        readonly code: string,
        message: string,
        readonly source: SourceLocation,
        options?: PackageErrorOptions,
    ) {
        super(`${source.file}:${source.line}:${source.column} ${source.path}: ${message}`, options);
        this.name = "PackageImportError";
        this.relatedSources = Object.freeze([...(options?.relatedSources ?? [])]);

        if (options?.reference) {
            this.reference = Object.freeze({ ...options.reference });
        }
    }
}

export function throwImportErrors(errors: readonly PackageImportError[]): void {
    if (errors.length === 1 && errors[0]) {
        throw errors[0];
    }

    if (errors.length > 1) {
        throw new AggregateError(
            errors,
            `Package import has ${errors.length} problems:\n${errors.map((error) => error.message).join("\n")}`,
        );
    }
}
