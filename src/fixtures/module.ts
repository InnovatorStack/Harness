import { spendContext } from "../core/context.js";
import { setOwn } from "../core/data.js";
import { defineOperation } from "../core/operation.js";
import type { ExecutionContext, HarnessModule } from "../core/types.js";
import { seedRecordsOperation } from "../platform/engine.js";
import { PlatformError } from "../platform/errors.js";
import { matches } from "../platform/query.js";
import { normalizeProperties } from "../platform/values.js";
import type {
    HarnessStorage,
    ItemTypeDefinition,
    StorageValue,
    StoredItem,
} from "../storage/types.js";
import type { Fixtures, FixtureRecord } from "./types.js";

interface PendingRecord {
    readonly id: string;
    readonly definition: ItemTypeDefinition;
    readonly values: FixtureRecord;
}

export const loadFixtureRecords = defineOperation<Fixtures, void>("fixtures.load");

export function createFixtureModule(
    storage: HarnessStorage,
    nextId: () => string = () => crypto.randomUUID().replaceAll("-", "").toUpperCase(),
): HarnessModule {
    return {
        id: "fixtures",
        requires: ["platform"],

        setup(registrar) {
            registrar.handleSync(loadFixtureRecords, (fixtures, context) => {
                load(fixtures, storage, context, nextId);
            });
        },
    };
}

function load(
    fixtures: Fixtures,
    storage: HarnessStorage,
    context: ExecutionContext,
    nextId: () => string,
): void {
    const pending: PendingRecord[] = [];

    for (const [type, records] of Object.entries(fixtures)) {
        const definition = storage.getItemType(type);

        if (!definition) {
            throw new PlatformError(
                "MissingItemType",
                `Fixture ItemType '${type}' is not imported.`,
            );
        }

        for (const values of records) {
            spendContext(context);
            pending.push({
                id: nextId(),
                definition,
                values,
            });
        }
    }

    // Reserve every identity before resolving edges, so required references may form cycles.
    const targets = new Set(
        pending.map((record) =>
            JSON.stringify([record.definition.name.toLowerCase(), record.id.toLowerCase()]),
        ),
    );
    const candidates = pending.map((record): StoredItem => ({
        id: record.id,
        type: record.definition.name,
        properties: normalizeProperties(storage, record.definition, scalarValues(record), {
            creating: false,
            pendingReferences: targets,
        }),
    }));
    const records = pending.map((record) => ({
        id: record.id,
        type: record.definition.name,
        properties: resolveValues(record, candidates, storage, context),
    }));
    context.executeSync(seedRecordsOperation, records);
}

function scalarValues(record: PendingRecord): Record<string, StorageValue> {
    const values: Record<string, StorageValue> = {
        config_id: record.id,
        generation: 1,
        is_current: 1,
    };

    for (const property of record.definition.properties) {
        if (property.defaultValue !== undefined) {
            setOwn(values, property.name, property.defaultValue);
        }
    }

    for (const [name, value] of Object.entries(record.values)) {
        if (value === null || typeof value !== "object") {
            setOwn(values, name, value);
        }
    }

    return values;
}

function resolveValues(
    record: PendingRecord,
    candidates: readonly StoredItem[],
    storage: HarnessStorage,
    context: ExecutionContext,
): Record<string, StorageValue> {
    const values: Record<string, StorageValue> = {};

    for (const [name, value] of Object.entries(record.values)) {
        if (value === null || typeof value !== "object") {
            setOwn(values, name, value);
            continue;
        }

        const property = record.definition.properties.find((property) => property.name === name);
        const target = storage
            .listItemTypes()
            .find((type) => type.id.toLowerCase() === property?.dataSource?.toLowerCase());

        if (property?.dataType !== "item" || !target) {
            throw new PlatformError(
                "InvalidFixtureReference",
                `'${record.definition.name}.${name}' has no imported ItemType target.`,
            );
        }

        const predicates = Object.entries(value).map(([name, value]) => ({ name, value }));

        if (predicates.length === 0) {
            throw new PlatformError(
                "InvalidFixtureReference",
                "Fixture references require a non-empty selector.",
            );
        }

        for (const { name } of predicates) {
            if (name !== "id" && !target.properties.some((property) => property.name === name)) {
                throw new PlatformError(
                    "UnknownProperty",
                    `Unknown fixture selector '${target.name}.${name}'.`,
                );
            }
        }

        const available = [
            ...storage.listItems(target.name),
            ...candidates.filter((candidate) => candidate.type === target.name),
        ];
        const matching = available.filter((candidate) => {
            spendContext(context, predicates.length);

            return predicates.every((predicate) => matches(storage, target, candidate, predicate));
        });
        const reference = matching[0];

        if (matching.length !== 1 || !reference) {
            const code = matching.length === 0 ? "UnresolvedFixtures" : "AmbiguousFixtureReference";

            throw new PlatformError(
                code,
                `Fixture '${record.definition.name}.${name}' selector ${JSON.stringify(value)} ` +
                    `matched ${matching.length} '${target.name}' records; expected one.`,
            );
        }

        setOwn(values, name, reference.id);
    }

    return values;
}
