export interface ClockSettings {
    readonly at: string;
}

export interface ClockControl {
    now(): Date;
    set(value: string | Date): void;
    advance(milliseconds: number): void;
}

/** An immutable starting instant; each world owns its own clock. */
export function fixedClock(value: string | Date): ClockSettings {
    return Object.freeze({ at: new Date(instant(value)).toISOString() });
}

export function clockSettings(value: unknown): ClockSettings | undefined {
    if (value === undefined) {
        return undefined;
    }

    if (
        value === null ||
        typeof value !== "object" ||
        !("at" in value) ||
        typeof value.at !== "string" ||
        Object.keys(value).some((key) => key !== "at")
    ) {
        throw new TypeError("Harness clock must be configured with fixedClock().");
    }

    return fixedClock(value.at);
}

export class WorldClock {
    private current: number | undefined;
    private baseline: number | undefined;

    constructor(settings?: ClockSettings) {
        this.current = settings === undefined ? undefined : instant(settings.at);
        this.baseline = this.current;
    }

    now(): Date {
        return new Date(this.current ?? Date.now());
    }

    control(assertOpen: () => void, assertIdle: () => void): ClockControl {
        return Object.freeze({
            now: () => {
                assertOpen();

                return this.now();
            },

            set: (value: string | Date) => {
                assertIdle();
                this.current = instant(value);
            },

            advance: (milliseconds: number) => {
                assertIdle();

                if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
                    throw new TypeError(
                        "Clock advancement requires nonnegative integer milliseconds.",
                    );
                }

                this.current = instant(new Date(this.now().getTime() + milliseconds));
            },
        });
    }

    checkpoint(): void {
        this.baseline = this.current;
    }

    capture(): number | undefined {
        return this.current;
    }

    restore(value: number | undefined): void {
        this.current = value;
        this.checkpoint();
    }

    reset(): void {
        this.current = this.baseline;
    }
}

function instant(value: string | Date): number {
    if (typeof value !== "string" && !(value instanceof Date)) {
        throw new TypeError("Clock instants must be strings or Dates.");
    }

    if (typeof value === "string" && !/(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
        throw new TypeError("Clock instants must include an explicit timezone.");
    }

    const milliseconds = value instanceof Date ? value.getTime() : Date.parse(value);

    if (!Number.isFinite(milliseconds)) {
        throw new TypeError("The clock requires a valid date.");
    }

    return milliseconds;
}
