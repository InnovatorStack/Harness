import { expect, test } from "bun:test";

import { fieldValue, resolveField } from "../src/platform/queries/fields.js";
import { evaluate } from "../src/queries/evaluate.js";
import { PredicateParser } from "../src/queries/parser.js";
import { selectQuery } from "../src/queries/types.js";
import { SqliteStorage } from "../src/storage/sqlite/storage.js";
import type { ItemTypeDefinition } from "../src/storage/types.js";

const definition: ItemTypeDefinition = {
    id: "SELECTION",
    name: "Selection",
    properties: [
        { name: "text", dataType: "string" },
        { name: "decimal", dataType: "decimal" },
        { name: "number", dataType: "float" },
        { name: "date", dataType: "date" },
    ],
};

const decimalValues = [
    null,
    "-9007199254740992.01",
    "-0.000000000000001",
    "0",
    "9007199254740992.01",
    "9007199254740992.02",
    "123456789012345678901234567890.01",
];
const textValues = [null, "", "alpha", "ALPHA", "O'Neil", "😀", "é"];
const ids = ["PLAIN_ID", "ascii_other", "é", "É", "K", "K", "0001"];

test("SQLite candidate selection never drops matches from the precise evaluator", () => {
    const storage = new SqliteStorage();

    try {
        storage.defineItemType(definition);

        for (let index = 0; index < ids.length; index += 1) {
            const id = ids[index];

            if (!id) {
                throw new Error("Expected a selection identity.");
            }

            storage.insertItem({
                type: definition.name,
                id,
                properties: {
                    text: textValues[index] ?? null,
                    decimal: decimalValues[index] ?? null,
                    number: index === 0 ? null : index,
                    date: index === 0 ? null : `2026-01-01T00:00:00.000000${index}`,
                },
            });
        }

        assertSelections(storage);
    } finally {
        storage.close();
    }
});

function assertSelections(storage: SqliteStorage): void {
    const atoms = [
        "text = 'alpha'",
        "text LIKE '%A%'",
        "text IS NULL",
        "text IN ('', NULL)",
        "number > 2",
        "number NOT IN (2, NULL)",
        "decimal = 9007199254740992.01",
        "decimal > 9007199254740992.01",
        "decimal < -0.000000000000001",
        "decimal IN (9007199254740992.01, NULL)",
        "date > '2026-01-01T00:00:00.0000004'",
        "id = 'é'",
        "id = 'k'",
    ];
    const expressions = atoms.flatMap((left) => [
        left,
        `NOT (${left})`,
        ...atoms.flatMap((right) => [
            `(${left}) OR (${right})`,
            `NOT ((${left}) AND NOT (${right}))`,
        ]),
    ]);
    const records = storage.listItems(definition.name);

    for (const expression of expressions) {
        const predicate = new PredicateParser(expression, (names) =>
            resolveField(storage, definition, names),
        ).parse();
        const matches = (record: (typeof records)[number]) =>
            evaluate(
                predicate,
                (field) => fieldValue(storage, record, field),
                () => {},
            );
        const expected = records
            .filter(matches)
            .map((record) => record.id)
            .sort();
        const actual = storage[selectQuery](definition.name, predicate, () => {})
            .filter(matches)
            .map((record) => record.id)
            .sort();

        expect(actual, expression).toEqual(expected);
    }
}

test("query parsing rejects malformed syntax and bounds deeply nested or excessive input", () => {
    const invalid = [
        "",
        "text = 'x' AND",
        "(text = 'x'",
        "text = 'x')",
        "NOT",
        "text IN ()",
        "text = 'x' /* comment */",
        "text LIKE '[abc]'",
        `${"NOT ".repeat(600)}text = 'x'`,
        `text = '${"x".repeat(70_000)}'`,
    ];

    for (const expression of invalid) {
        expect(() => new PredicateParser(expression, field).parse()).toThrow();
    }

    const flat = Array.from({ length: 200 }, () => "text = 'x'").join(" AND ");
    expect(new PredicateParser(flat, field).parse().kind).toBe("and");
});

function field() {
    return { name: "text", column: "text", kind: "text", path: [] } as const;
}
