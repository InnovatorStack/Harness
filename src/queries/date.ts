/** Neutral AML dates are UTC; fractional precision is retained through seven decimal places. */
export function dateKey(value: string): string {
    const match =
        /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,7}))?(Z|[+-]\d{2}:\d{2})?)?$/iu.exec(
            value,
        );
    const date = match?.[1];

    if (!date) {
        throw new TypeError("Date queries require ISO dates or neutral AML datetimes.");
    }

    const midnight = Date.parse(`${date}T00:00:00Z`);

    if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== date) {
        throw new TypeError("Invalid calendar date in query.");
    }

    const time = match[2] ?? "00:00:00";
    const zone = match[4] ?? "Z";
    const milliseconds = Date.parse(`${date}T${time}${zone}`);

    if (!Number.isFinite(milliseconds) || time.startsWith("24:")) {
        throw new TypeError("Invalid time or timezone in query.");
    }

    return String(BigInt(milliseconds) * 10_000n + BigInt((match[3] ?? "").padEnd(7, "0")));
}
