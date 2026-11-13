---
title: "Versions and relationships"
---

## Automatic and manual generations

For an automatically versioned ItemType, `edit` locks, saves, and unlocks. The first save in a lock cycle creates a new ID, retains `config_id`, increments `generation`, and marks the previous generation as noncurrent. Further `update` calls during that lock cycle reuse the new generation. `version="0"` suppresses automatic versioning; `manual_versioning=1` requires the `version` action. These rules follow the [Aras Programmer's Guide](https://aras.com/wp-content/uploads/2025/06/Aras-Innovator-2025-Release-Programmers-Guide.pdf). Configure `session.user` in `.harness/config.ts` for versionable mutations.

For automatic versioning, `new_version` is `0` before the first save, becomes `1` after that
save, and returns to `0` on unlock. Locking an already owned Item preserves the marker.
Manual versioning preserves its stored marker and does not create generations implicitly.

## Current and historical records

Ordinary queries return current generations. An explicit ID, `generation`, or `is_current` selector can retrieve history. After submitting a Method, fetch by `config_id` and `is_current: 1` to inspect the resulting stored generation. Versioning clones current owned relationships, including versionable relationship records, as fresh configurations beneath the new parent. Original relationship histories remain intact. Version, update, lock, unlock, and transactional promotion effects share the caller's transaction and roll back together.

## Fixed and floating references

Fixed/floating item properties use exported `Property.item_behavior`. Relationships use their
stored `behavior`, RelationshipType defaults and source lifecycle `item_behavior`; hard policies
retain their precedence. Versioning updates floating references transactionally, freezes historical
relationships and points copied relationships at the latest related generation. Historical source
generations retain their references. An unspecified relationship policy defaults to fixed in the
current implementation; release-qualified native comparisons remain pending.

## Ownership and dependent deletion

Deleting an owner removes its owned relationship records through normal event chains. Dependent
Items are removed when their last owning reference disappears, including item-property updates.
Other live references reject deletion. A Method or AML batch may create and attach dependent Items
within one request; orphan checks run before that outer request completes. Fixtures remain explicit
starting data and bypass business creation checks. Cascades, cleanup and validation share rollback,
execution reports and world reset behavior.

## Released revisions

Versioning a released item advances its exported `Revision` sequence, retains `config_id`, increments
the generation and resets the lifecycle to its configured start state. Historical revision values, state
and dates remain readable. The new cycle clears release dates, applies start-state flags and permissions,
and recalculates copied relationship behavior. Sequence exhaustion rejects the request transactionally.
An explicit `version="0"` cannot save a released generation. Native release-specific comparisons remain
pending; change-management applications and released relationship cloning remain separate work.
