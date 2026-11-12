import { WorldClock, clockSettings } from "./clock.js";
import type { ClockSettings } from "./clock.js";
import { WorldIds, idSettings } from "./ids.js";
import type { IdPosition, IdSettings } from "./ids.js";

export interface ValueSettings {
    readonly clock?: ClockSettings;
    readonly ids?: IdSettings;
}

export interface ValuePosition {
    readonly clock: number | undefined;
    readonly ids: IdPosition;
}

/** Own only generated values. Transaction rollback does not rewind already-issued identities. */
export class WorldValues {
    readonly clock: WorldClock;
    readonly ids: WorldIds;

    constructor(settings: ValueSettings) {
        this.clock = new WorldClock(clockSettings(settings.clock));
        this.ids = new WorldIds(idSettings(settings.ids));
    }

    checkpoint(): void {
        this.clock.checkpoint();
        this.ids.checkpoint();
    }

    capture(): ValuePosition {
        return { clock: this.clock.capture(), ids: this.ids.capture() };
    }

    restore(position: ValuePosition): void {
        this.clock.restore(position.clock);
        this.ids.restore(position.ids);
    }

    reset(): void {
        this.clock.reset();
        this.ids.reset();
    }
}
