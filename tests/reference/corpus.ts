import { join } from "node:path";

import { readTextFile } from "../../src/core/files.js";
import { parseAml } from "../../src/packages/parser.js";
import { actionResponseCases } from "./cases/action-responses.js";
import { actionCases } from "./cases/actions.js";
import { classificationCases } from "./cases/classifications.js";
import { collectionCases } from "./cases/collections.js";
import { eventCases } from "./cases/events.js";
import { permissionCases } from "./cases/permissions.js";
import { queryCases } from "./cases/queries.js";
import { referenceCases } from "./cases/references.js";
import { revisionCases } from "./cases/revisions.js";
import { sourceAccessCases } from "./cases/source-access.js";
import { stateEventCases } from "./cases/state-events.js";
import { teamCases } from "./cases/teams.js";
import { versioningCases } from "./cases/versioning.js";
import {
    authorization,
    clock,
    contextProperties,
    fixtureBindings,
    idProperties,
    idsSeed,
    payloadAttributes,
    sessionUser,
    watchedTypes,
} from "./model.js";
import type { ReferenceCase } from "./types.js";

export const corpusDirectory = import.meta.dir;
export const cases: readonly ReferenceCase[] = [
    ...actionCases,
    ...actionResponseCases,
    ...versioningCases,
    ...eventCases,
    ...queryCases,
    ...referenceCases,
    ...collectionCases,
    ...revisionCases,
    ...stateEventCases,
    ...permissionCases,
    ...teamCases,
    ...classificationCases,
    ...sourceAccessCases,
];

export interface Corpus {
    readonly files: readonly { readonly path: string; readonly xml: string }[];
    readonly anchors: ReadonlySet<string>;
    hash(definition: ReferenceCase): string;
}

export async function loadCorpus(): Promise<Corpus> {
    const paths = [
        ...new Bun.Glob(".harness/**/*.xml").scanSync({ cwd: corpusDirectory, dot: true }),
    ].sort();
    const files: { readonly path: string; readonly xml: string }[] = [];
    const anchors = new Set<string>();

    if (paths.length === 0 || paths.length > 100) {
        throw new Error("The reference corpus requires 1–100 original XML inputs.");
    }

    for (const path of paths) {
        const xml = await readTextFile(join(corpusDirectory, path));
        const pending = [...parseAml(xml, path).items];
        files.push({ path: path.replaceAll("\\", "/"), xml });

        while (pending.length > 0) {
            const element = pending.pop();

            if (!element) {
                throw new Error("A pending package element must exist.");
            }

            if (element.attributes.id) {
                anchors.add(element.attributes.id.toUpperCase());
            }

            for (const child of element.children) {
                if (child.kind === "element") {
                    pending.push(child);
                }
            }
        }
    }

    return {
        files,
        anchors,

        hash(definition) {
            const input = {
                schemaVersion: 1,
                files,
                watchedTypes,
                fixtureBindings,
                contextProperties,
                payloadAttributes,
                sessionUser,
                authorization,
                clock,
                idsSeed,
                idProperties: [...idProperties].sort(),
                id: definition.id,
                capabilities: definition.capabilities,
                steps: definition.steps,
            };

            return new Bun.CryptoHasher("sha256").update(JSON.stringify(input)).digest("hex");
        },
    };
}

export function inputBundle(corpus: Corpus) {
    return {
        schemaVersion: 1,
        files: corpus.files,
        fixtureBindings,
        watchedTypes,
        idProperties: [...idProperties],
        contextProperties,
        payloadAttributes,
        sessionUser,
        authorization,
        clock,
        idsSeed,
        cases: cases.map((definition) => ({
            id: definition.id,
            capabilities: definition.capabilities,
            steps: definition.steps,
            inputHash: corpus.hash(definition),
        })),
    };
}
