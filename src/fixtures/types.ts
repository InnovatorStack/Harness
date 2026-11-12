import type { StorageValue } from "../storage/types.js";

/** An object value selects an existing record of the property's target ItemType. */
export type FixtureValue = StorageValue | Readonly<Record<string, StorageValue>>;

export type FixtureRecord = Readonly<Record<string, FixtureValue>>;

/** ItemType names map to starting records; schema always comes from packages. */
export type Fixtures = Readonly<Record<string, readonly FixtureRecord[]>>;
