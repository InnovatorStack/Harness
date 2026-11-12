import type { Item } from "../../items/item.js";

export enum AuthorizationMode {
    Native = "native",
    Unchecked = "unchecked",
}

export interface AuthorizationRequest {
    readonly kind: "action" | "method" | "transition";
    readonly name: string;
    readonly item?: Item;
}

export type AuthorizationPolicy =
    | AuthorizationMode
    | "unchecked"
    | ((request: AuthorizationRequest) => void | Promise<void>);
