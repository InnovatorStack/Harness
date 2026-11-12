import { baselineEntries } from "../../baseline/catalog.js";

const identities = new Map(
    baselineEntries
        .filter((entry) => entry.type === "Identity")
        .map((entry) => [String(entry.properties.name), entry.id]),
);

/** Virtual roles are identified by genuine standard IDs, even if their display names change. */
export function systemIdentity(id: string, name: string): boolean {
    return id.toLowerCase() === identities.get(name)?.toLowerCase();
}

export function systemIdentityId(name: string): string | undefined {
    return identities.get(name);
}
