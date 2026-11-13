import { decodePayload, object } from "../../items/codec.js";
import { Item } from "../../items/item.js";
import { parseItems } from "../../items/xml.js";
import { PlatformError } from "../../platform/errors.js";
import type { MethodPorts } from "../types.js";
import { decodeBaseInput } from "./base-input.js";
import type { BaseInput, BaseInputChange } from "./base-input.js";
import type { ManagedOrigins } from "./origins.js";
import type { ManagedSecurity } from "./security.js";

export interface ManagedCallbackState {
    readonly origins: ManagedOrigins;
    request?: BaseInput;
}

export function requestChange(state: ManagedCallbackState): BaseInputChange | undefined {
    return state.request?.change(state.origins);
}

export async function managedCallback(
    message: Record<string, unknown>,
    ports: MethodPorts,
    security: ManagedSecurity,
    state: ManagedCallbackState,
): Promise<Item> {
    if (security.handles(message.operation)) {
        return security.invoke(message.operation, message.payload, ports);
    }

    if (message.operation === "session") {
        return new Item({ items: [], result: ports.getUserId() });
    }

    if (message.operation === "newId") {
        if (!ports.getNewId) {
            return ports.fail("The Method executor has no Item ID port.");
        }

        return new Item({ items: [], result: ports.getNewId() });
    }

    if (message.operation === "sql") {
        return await sql(message.payload, ports);
    }

    if (message.operation === "eventBase") {
        return await applyEventBase(message.payload, ports, state);
    }

    if (message.operation === "apply") {
        return await ports.apply(new Item(decodePayload(message.payload)));
    }

    if (
        message.operation === "aml" &&
        object(message.payload) &&
        typeof message.payload.xml === "string"
    ) {
        return await ports.applyAML(message.payload.xml);
    }

    if (message.operation === "method") {
        return await method(message.payload, ports);
    }

    return ports.fail(
        object(message.payload) && typeof message.payload.capability === "string"
            ? message.payload.capability
            : "Unsupported managed callback operation.",
    );
}

async function applyEventBase(
    payload: unknown,
    ports: MethodPorts,
    state: ManagedCallbackState,
): Promise<Item> {
    if (
        !ports.serverEvent ||
        !object(payload) ||
        payload.name !== ports.serverEvent.name ||
        typeof payload.xml !== "string"
    ) {
        return ports.fail("Native base actions require the matching active replacement event.");
    }

    const input = decodeBaseInput(payload, state.origins);
    state.request = input;

    return await ports.serverEvent.applyBase(input.item);
}

async function sql(payload: unknown, ports: MethodPorts): Promise<Item> {
    if (!ports.applySQL || !object(payload) || typeof payload.sql !== "string") {
        return ports.fail("T-SQL execution is not implemented.");
    }

    const parameters = payload.parameters;

    if (parameters !== undefined && typeof parameters !== "string") {
        throw new PlatformError("InvalidProtocol", "SQL parameters must be XML text.");
    }

    return await ports.applySQL(payload.sql, parameters);
}

async function method(payload: unknown, ports: MethodPorts): Promise<Item> {
    if (!object(payload) || typeof payload.name !== "string" || typeof payload.body !== "string") {
        throw new PlatformError("InvalidProtocol", "Method callbacks require a name and AML body.");
    }

    const context = parseItems(`<Item type="Method" action="get">${payload.body}</Item>`)[0];

    if (!context) {
        throw new PlatformError("InvalidMethodContext", "Missing Method context.");
    }

    context.setAction(payload.name);

    return await ports.applyMethod(payload.name, context);
}
