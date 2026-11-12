/** Decimal comparison never passes through IEEE-754 or SQLite numeric affinity. */
export function decimal(value: string): {
    readonly negative: boolean;
    readonly whole: string;
    readonly fraction: string;
} {
    if (value.length > 4096) {
        throw new TypeError("Decimal queries exceed their text limit.");
    }

    const match = /^([+-]?)(\d+)(?:\.(\d+))?$/u.exec(value.trim());

    if (!match?.[2] || value.length > 4096) {
        throw new TypeError("Decimal queries require bounded, finite decimal text.");
    }

    const whole = match[2].replace(/^0+(?=\d)/u, "");
    const fraction = (match[3] ?? "").replace(/0+$/u, "");

    return { negative: match[1] === "-" && (whole !== "0" || fraction !== ""), whole, fraction };
}

export function decimalKey(value: string): string {
    const parsed = decimal(value);
    const sign = parsed.negative ? "-" : "";
    const fraction = parsed.fraction ? `.${parsed.fraction}` : "";

    return `${sign}${parsed.whole}${fraction}`;
}

export function compareDecimals(left: string, right: string): number {
    const a = decimal(left);
    const b = decimal(right);

    if (a.negative !== b.negative) {
        return a.negative ? -1 : 1;
    }

    let difference = Math.sign(a.whole.length - b.whole.length);

    if (difference === 0) {
        difference = lexical(a.whole, b.whole);
    }

    if (difference === 0) {
        const length = Math.max(a.fraction.length, b.fraction.length);
        difference = lexical(a.fraction.padEnd(length, "0"), b.fraction.padEnd(length, "0"));
    }

    return a.negative ? -difference : difference;
}

function lexical(left: string, right: string): number {
    if (left === right) {
        return 0;
    }

    return left < right ? -1 : 1;
}
