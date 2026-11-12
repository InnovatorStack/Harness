export interface IdSettings {
    readonly seed: string;
}

export interface IdPosition {
    readonly fixtures: number;
    readonly items: number;
}

const seedCharactersMax = 1024;

/** Seeded IDs retain the native 32-character uppercase hexadecimal format. */
export function seededIds(seed: string): IdSettings {
    if (typeof seed !== "string" || seed.length === 0 || seed.length > seedCharactersMax) {
        throw new TypeError(`An ID seed must contain 1–${seedCharactersMax} characters.`);
    }

    return Object.freeze({ seed });
}

export function idSettings(value: unknown): IdSettings | undefined {
    if (value === undefined) {
        return undefined;
    }

    if (
        value === null ||
        typeof value !== "object" ||
        !("seed" in value) ||
        typeof value.seed !== "string" ||
        Object.keys(value).some((key) => key !== "seed")
    ) {
        throw new TypeError("Harness ids must be configured with seededIds().");
    }

    return seededIds(value.seed);
}

export class WorldIds {
    private counters = { fixtures: 0, items: 0 };
    private baseline = { ...this.counters };

    constructor(private readonly settings?: IdSettings) {}

    fixture(): string {
        return this.next("fixtures");
    }

    item(): string {
        return this.next("items");
    }

    checkpoint(): void {
        this.baseline = { ...this.counters };
    }

    capture(): IdPosition {
        return { ...this.counters };
    }

    restore(position: IdPosition): void {
        this.counters = { ...position };
        this.checkpoint();
    }

    reset(): void {
        this.counters = { ...this.baseline };
    }

    private next(stream: keyof WorldIds["counters"]): string {
        if (this.counters[stream] >= Number.MAX_SAFE_INTEGER) {
            throw new RangeError("The world ID sequence is exhausted.");
        }

        this.counters[stream] += 1;

        if (!this.settings) {
            return crypto.randomUUID().replaceAll("-", "").toUpperCase();
        }

        return new Bun.CryptoHasher("sha256")
            .update(JSON.stringify([this.settings.seed, stream, this.counters[stream]]))
            .digest("hex")
            .slice(0, 32)
            .toUpperCase();
    }
}
