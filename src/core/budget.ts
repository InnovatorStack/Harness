/** A shared owner charges related phases against one finite work allowance. */
export class WorkBudget {
    private used = 0;

    constructor(
        private readonly maximum: number,
        private readonly exceeded: () => Error,
    ) {
        if (!Number.isSafeInteger(maximum) || maximum < 1) {
            throw new TypeError("A work budget must be a positive safe integer.");
        }
    }

    spend(units = 1): void {
        if (!Number.isSafeInteger(units) || units < 0) {
            throw new Error("Work charges must be nonnegative safe integers.");
        }

        if (units > this.maximum - this.used) {
            throw this.exceeded();
        }

        this.used += units;
    }
}
