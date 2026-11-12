import { PlatformError } from "../../platform/errors.js";
import type { MethodDefinition } from "../types.js";

const eventArguments: ReadonlyMap<string, string> = new Map([
    ["onget", "Aras.Server.Core.OnGetEventArgs"],
    ["onadd", "Aras.Server.Core.OnAddEventArgs"],
    ["onupdate", "Aras.Server.Core.OnUpdateEventArgs"],
    ["ondelete", "Aras.Server.Core.OnDeleteEventArgs"],
    ["onlock", "Aras.Server.Core.OnLockEventArgs"],
    ["onunlock", "Aras.Server.Core.OnUnlockEventArgs"],
    ["onpromote", "Aras.Server.Core.OnPromoteEventArgs"],
]);

export function methodTemplate(code: string): string {
    for (const line of code.split(/\r?\n/u)) {
        const content = line.trim();

        if (!content.startsWith("//") && content.length > 0) {
            break;
        }

        const match = /^\/\/\s*MethodTemplateName\s*=\s*([A-Za-z][\w]*)\s*;\s*$/u.exec(content);
        const name = match?.[1];

        if (name === "CSharpInOut") {
            return "InOut.cs.template";
        }

        if (name !== undefined && name !== "CSharp") {
            throw new PlatformError(
                "UnsupportedMethodTemplate",
                `C# template '${name}' is unavailable.`,
            );
        }
    }

    return "Method.cs.template";
}

export function eventArgumentType(name: string | undefined): string {
    if (name === undefined) {
        return "Aras.Server.Core.ServerEventArgs";
    }

    const type = eventArguments.get(name.toLowerCase());

    if (!type) {
        throw new PlatformError(
            "UnsupportedEventData",
            `CSharpInOut event data for '${name}' is unavailable.`,
        );
    }

    return type;
}

export function renderMethod(
    source: string,
    method: MethodDefinition,
    typeName: string,
    eventType: string,
): string {
    const replacements = new Map([
        ["__TYPE_NAME__", typeName],
        ["__SOURCE_LINE__", String(method.source.line)],
        ["__SOURCE_PATH__", method.source.file.replaceAll("\\", "\\\\").replaceAll('"', '\\"')],
        ["__METHOD_CODE__", method.code],
        ["__EVENT_ARGS_TYPE__", eventType],
    ]);

    return source.replaceAll(/__[A-Z_]+__/gu, (placeholder) => {
        const value = replacements.get(placeholder);

        if (value === undefined) {
            throw new Error(`Missing managed template value '${placeholder}'.`);
        }

        return value;
    });
}
