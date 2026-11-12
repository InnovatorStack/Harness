import type { WatchedType } from "./types.js";

const identityProperties = ["config_id", "generation", "is_current", "locked_by_id", "new_version"];
const documentProperties = ["item_number", "name", "note", ...identityProperties];

export const sessionUser = { login_name: "reference_owner" };
export const contextProperties = ["plain"];
export const payloadAttributes = [
    "id",
    "action",
    "version",
    "serverEvents",
    "select",
    "orderBy",
    "where",
    "idlist",
    "page",
    "pagesize",
    "maxRecords",
    "isCriteria",
    "transition_id",
    "from_state",
    "to_state",
];

export const watchedTypes: readonly WatchedType[] = [
    {
        type: "RefDocument",
        keys: ["item_number", "generation"],
        properties: [...documentProperties, "state", "current_state", "fixed_ref", "float_ref"],
    },
    { type: "RefManual", keys: ["item_number", "generation"], properties: documentProperties },
    { type: "RefPlain", keys: ["item_number"], properties: [...documentProperties, "owned_ref"] },
    { type: "RefDependent", keys: ["item_number"], properties: documentProperties },
    {
        type: "RefRevision",
        keys: ["item_number", "generation"],
        properties: [
            ...documentProperties,
            "major_rev",
            "state",
            "current_state",
            "is_released",
            "not_lockable",
            "release_date",
            "effective_date",
            "superseded_date",
        ],
    },
    { type: "RefBatch", keys: ["item_number", "generation"], properties: documentProperties },
    { type: "RefStateRecord", keys: ["item_number", "generation"], properties: documentProperties },
    {
        type: "RefBatchLink",
        keys: ["source_id", "label", "generation"],
        properties: ["source_id", "related_id", "label", "behavior", ...identityProperties],
    },
    {
        type: "RefRequired",
        keys: ["item_number"],
        properties: [...documentProperties, "required_note"],
    },
    { type: "RefReplacement", keys: ["item_number"], properties: documentProperties },
    {
        type: "RefLink",
        keys: ["source_id", "label"],
        properties: ["source_id", "related_id", "label", "behavior", ...identityProperties],
    },
];

/** Only declared identity fields are normalized. ID-shaped business text remains literal. */
export const idProperties = new Set([
    "id",
    "config_id",
    "source_id",
    "related_id",
    "locked_by_id",
    "current_state",
    "transition_id",
    "from_state",
    "to_state",
    "plain",
    "fixed_ref",
    "float_ref",
    "owned_ref",
]);

export const fixtureBindings = {
    "state-record": { type: "RefStateRecord", item_number: "STATE-001" },
    revision: { type: "RefRevision", item_number: "REV-001" },
    "last-revision": { type: "RefRevision", item_number: "REV-002" },
    "batch-first": { type: "RefBatch", item_number: "BATCH-001" },
    "batch-second": { type: "RefBatch", item_number: "BATCH-002" },
    document: { type: "RefDocument", item_number: "DOC-001" },
    locked: { type: "RefDocument", item_number: "LOCKED-001" },
    manual: { type: "RefManual", item_number: "MANUAL-001" },
    plain: { type: "RefPlain", item_number: "PLAIN-001" },
    required: { type: "RefRequired", item_number: "REQUIRED-001" },
    replacement: { type: "RefReplacement", item_number: "REPLACEMENT-001" },
};
