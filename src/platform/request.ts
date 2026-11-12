import { setOwn } from "../core/data.js";
import type { ItemNode } from "../items/item.js";
import { PlatformError } from "./errors.js";

const attributes = new Set([
    "id",
    "action",
    "select",
    "orderBy",
    "where",
    "serverEvents",
    "version",
    "idlist",
    "page",
    "pagesize",
    "maxRecords",
    "isCriteria",
    "isNew",
    "isTemp",
]);

/** Validate again after before events, which may change the request. */
export function validateRequest(request: ItemNode, action: string): void {
    for (const [name, attributes] of Object.entries(request.propertyAttributes)) {
        if (
            action !== "get" &&
            attributes.condition !== undefined &&
            attributes.condition !== "eq"
        ) {
            throw new PlatformError(
                "UnsupportedCondition",
                `Property condition '${attributes.condition}' on '${name}' is not implemented.`,
            );
        }

        if (attributes.is_null === "1") {
            setOwn(request.properties, name, null);
        }
    }

    validateCriteria(request, action);

    for (const key of Object.keys(request.attributes)) {
        if (!attributes.has(key)) {
            throw new PlatformError(
                "UnsupportedAttribute",
                `AML attribute '${key}' is not implemented.`,
            );
        }
    }

    if (
        request.attributes.serverEvents !== undefined &&
        !["0", "1"].includes(request.attributes.serverEvents)
    ) {
        throw new PlatformError("InvalidServerEvents", "serverEvents must be '0' or '1'.");
    }

    if (
        request.attributes.version !== undefined &&
        (!["edit", "update"].includes(action) || !["0", "1"].includes(request.attributes.version))
    ) {
        throw new PlatformError(
            "InvalidVersion",
            "version must be '0' or '1' on an edit or update request.",
        );
    }

    if (
        !["get", "add", "edit", "update"].includes(action) &&
        Object.keys(request.propertyItems).length
    ) {
        throw new PlatformError(
            "UnsupportedPropertyMutation",
            "Nested property Item mutations are not implemented. Pass a resolved record reference instead.",
        );
    }

    if (!["add", "get", "edit", "update"].includes(action) && request.relationships.length) {
        throw new PlatformError(
            "UnsupportedRelationships",
            `Nested relationship requests on '${action}' are not implemented. Apply relationship actions separately.`,
        );
    }
}

function validateCriteria(request: ItemNode, action: string): void {
    if (action !== "get") {
        for (const name of ["page", "pagesize", "maxRecords", "isCriteria"]) {
            if (request.attributes[name] !== undefined) {
                throw new PlatformError(
                    "UnsupportedAttribute",
                    `AML attribute '${name}' is only supported on get requests.`,
                );
            }
        }

        if ((request.logical?.length ?? 0) > 0) {
            throw new PlatformError(
                "UnsupportedCondition",
                "Logical groups require a get request; use where or idlist for mutations.",
            );
        }
    }

    if (
        !["get", "add"].includes(action) &&
        !["id", "where", "idlist"].some((name) => request.attributes[name]?.trim())
    ) {
        throw new PlatformError(
            "InvalidSelector",
            "Mutations require id, idlist or where criteria.",
        );
    }

    if (
        request.attributes.isCriteria !== undefined &&
        !["0", "1"].includes(request.attributes.isCriteria)
    ) {
        throw new PlatformError("InvalidSelector", "isCriteria must be '0' or '1'.");
    }
}
