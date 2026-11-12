import type { SourceLocation } from "../diagnostics/source-location.js";
import type { Item } from "../items/item.js";

export interface MethodDefinition {
    readonly id: string;
    readonly name: string;
    readonly language: string;
    readonly code: string;
    readonly hash: string;
    readonly source: SourceLocation;
}

export interface MethodPorts {
    /** Notify when source evaluation begins, after compilation and host setup. */
    executionStarted?(): void;
    getUserId(): string;
    getNewId?(): string;
    apply(item: Item): Promise<Item>;
    applyAML(xml: string): Promise<Item>;
    applyMethod(name: string, context: Item): Promise<Item>;
    applySQL?(query: string, parameters?: string): Promise<Item>;
    readonly security?: MethodSecurity;
    readonly serverEvent?: MethodServerEvent;
    fail(message: string): never;
}

export interface MethodServerEvent {
    readonly name: string;
    applyBase(request: Item): Promise<Item>;
}

export interface MethodIdentity {
    readonly id: string;
    readonly name: string;
}

export interface MethodSecurity {
    getIdentities(): readonly string[];
    getIdentityByName(name: string): MethodIdentity | undefined;
    grantIdentity(id: string): Disposable;
}

export interface MethodExecutor {
    readonly language: string;
    execute(method: MethodDefinition, context: Item, ports: MethodPorts): Promise<Item>;
    reset?(): void;
    dispose?(): void;
}
