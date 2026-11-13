import { AuthorizationMode } from "../../src/index.js";
import type { WatchedType } from "./types.js";

const identityProperties = [
    "config_id",
    "generation",
    "is_current",
    "locked_by_id",
    "new_version",
    "permission_id",
];
const documentProperties = ["item_number", "name", "note", ...identityProperties];
const namedProperties = ["item_number", "name", ...identityProperties];

export const sessionUser = { login_name: "reference_owner" };
export const authorization = AuthorizationMode.Native;
export const clock = "2026-01-01T00:00:00Z";
export const idsSeed = "reference-corpus";
export const contextProperties = ["plain"];
export const payloadAttributes = [
    "id",
    "action",
    "version",
    "oldId",
    "serverEvents",
    "doGetItem",
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
            ...namedProperties,
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
    { type: "RefBatch", keys: ["item_number", "generation"], properties: namedProperties },
    { type: "RefStateRecord", keys: ["item_number", "generation"], properties: documentProperties },
    { type: "RefEventRecord", keys: ["item_number", "generation"], properties: documentProperties },
    {
        type: "RefPropertyRecord",
        keys: ["item_number", "generation"],
        properties: [...documentProperties, "fixed_ref"],
    },
    {
        type: "RefOriginRecord",
        keys: ["item_number", "generation"],
        properties: documentProperties,
    },
    {
        type: "RefOriginLink",
        keys: ["source_id", "label", "generation"],
        properties: ["source_id", "label", "behavior", ...identityProperties],
    },
    {
        type: "RefBatchLink",
        keys: ["source_id", "label", "generation"],
        properties: [
            "source_id",
            "related_id",
            "label",
            "behavior",
            "state",
            "current_state",
            "is_released",
            "not_lockable",
            ...identityProperties,
        ],
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
    {
        type: "RefSecurityRecord",
        keys: ["item_number"],
        properties: [...namedProperties, "team_id", "owned_by_id", "state", "current_state"],
    },
    {
        type: "RefSecurityLink",
        keys: ["source_id", "label"],
        properties: [
            "source_id",
            "related_id",
            "team_id",
            "owned_by_id",
            "managed_by_id",
            "created_by_id",
            "label",
            ...identityProperties,
        ],
    },
    { type: "RefNoAdd", keys: ["item_number"], properties: ["item_number", ...identityProperties] },
    {
        type: "RefClassified",
        keys: ["item_number"],
        properties: [
            ...namedProperties,
            "classification",
            "state",
            "current_state",
            "is_released",
            "not_lockable",
        ],
    },
    {
        type: "RefClassDefault",
        keys: ["item_number"],
        properties: [...namedProperties, "classification"],
    },
    {
        type: "Team Identity",
        keys: ["source_id", "related_id"],
        properties: ["source_id", "related_id", "team_role", ...identityProperties],
        sourceIds: [
            "B7200000000000000000000000000001",
            "B7200000000000000000000000000002",
            "B7200000000000000000000000000003",
            "B7200000000000000000000000000004",
        ],
    },
];

/** Only declared identity fields are normalized. ID-shaped business text remains literal. */
export const idProperties = new Set([
    "id",
    "oldId",
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
    "permission_id",
    "owned_by_id",
    "team_id",
    "team_role",
    "managed_by_id",
    "created_by_id",
]);

export const fixtureBindings = {
    "property-record": { type: "RefPropertyRecord", item_number: "PROPERTY-001" },
    "event-record": { type: "RefEventRecord", item_number: "EVENT-001" },
    "origin-record": { type: "RefOriginRecord", item_number: "ORIGIN-001" },
    "origin-link": { type: "RefOriginLink", label: "Existing" },
    "class-start": { type: "RefClassified", item_number: "CLASS-START" },
    "class-advanced": { type: "RefClassified", item_number: "CLASS-ADVANCED" },
    "class-root": { type: "RefClassified", item_number: "CLASS-EXISTING-ROOT" },
    "security-denied": { type: "RefSecurityRecord", item_number: "HIDDEN" },
    "security-owner": { type: "RefSecurityRecord", item_number: "OWNER" },
    "access-change": { type: "RefSecurityRecord", item_number: "NO-ACCESS-CHANGE" },
    "team-manager": { type: "RefSecurityRecord", item_number: "TEAM-02" },
    "delete-parent": { type: "RefSecurityRecord", item_number: "DELETE-PARENT" },
    "delete-child": { type: "RefSecurityLink", label: "Owned deletion" },
    "team-promote": { type: "RefSecurityRecord", item_number: "PROMOTE-YES" },
    "team-reject": { type: "RefSecurityRecord", item_number: "PROMOTE-NO" },
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
