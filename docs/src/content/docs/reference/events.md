---
title: "Events"
---

## Event contexts

Server Events use their exported `event_version`. Version-1 after hooks load each stored Item through
Get, independently of the caller's `select`. After-version receives the historical Item; its native
`eventData.NewItemId` identifies the new generation. Version-2 before-update and after-add/update/version
hooks receive an empty Item with native event metadata. After hooks run once per completed batch;
before-update runs for each update invocation. `OldIdsNewIdsMap` and `NewItemsIds` identify the batch.
Without item handlers, the after-version scalar ID is empty and the after-update scalar ID is null.
Custom executors receive immutable `MethodPorts.eventData`, discriminated by `MethodEventDataKind`.
Nested ordinary Methods receive no inherited event metadata. Both C# templates expose the corresponding
native argument classes. Hook writes, errors and metadata snapshots retain transaction/reset isolation.

## Shared input and returned results

Ordinary before/after hooks share mutable input. A separately returned Item, text or empty Result
does not replace that input. After-Get hooks mutate the actual result collection; their separate
responses leave its paging metadata intact. Any returned SOAP fault rejects the hook and rolls
back the request, including a no-items fault with code `0`. Nested ordinary Methods can handle
their own no-items results. Replacement Methods and direct Method calls retain their returned
responses; C# `return null` supplies an empty Result.

## Version event order

Automatic versioning runs before-update before deciding to create a generation. A hook can set
`version="0"` to save in place. When versioning starts, the selected batch uses the original pending
request and enters update again with new IDs, `oldId` and the automatic `new_version=1` marker.
Explicit version skips the initial replacement and before-update pass. Version hooks run despite `serverEvents="0"`;
optional update hooks remain suppressed. Versioning releases historical source locks before
after-version hooks run. Every before-unlock hook runs before the batch is cleared; owned dependent Items are
unlocked before the after hooks. These writes and Method side effects share rollback and world reset.
Automatic source markers reset to zero; manual markers remain unchanged. Hook contexts containing
only type and ID are hydrated through Get and retain shared pending values across the unlock batch.
Administrative lock overrides remain unimplemented. Native event context profiles are still unverified.
Before-version Methods share pending request values. Supported input changes remain visible after
rejection or an exception, while stored writes roll back. Original selection criteria are captured
before hooks normalize the input. Cloning preserves stored business values
until the subsequent update hooks finish; after-version Methods can query that intermediate clone.

Generated updates enter `onUpdate` again with versioning disabled. The replacement can modify pending
values and delegate, or supply its own result without applying the update. Base delegation retains
the selected generation IDs and checks every target's permissions before running update hooks.
Explicit `version` preserves the original ID, ID list or validated WHERE expression in `oldId`;
automatic versioning uses the selected IDs. Single-ID criteria become `id`; other criteria become
`idlist`. Copied relationship IDs are remapped before the generated replacement runs. Direct update
and version delegates retrieve their results before the replacement resumes. The edit wrapper locks
before replacement, requests minimal update results, then unlocks returned target IDs and performs
the final Get. Its implicit locks bypass `onLock`/`onUnlock` replacements while retaining ordinary
hooks. Response-only changes stay transient; source failures roll back the whole request.
Versionable edit replacements must return target Items; text results fail with a diagnostic.

## Relationship copies

Parent versioning clones stored relationship values without `onBeforeCopy`, `onAfterCopy`,
or relationship add/update hooks. Required and inherited bindings are also skipped; their mocks
and executors are never consulted. Nested owned records exist before the parent's after-version
hooks run. Copied rows, references and later Method writes share the request's rollback and reset.
After the owned graph exists, copied relationships restart their classification-selected default
lifecycle. The start state supplies state flags and its Permission; permission inheritance and
nested reference policies run before after-version hooks. Without a default map, copies clear
their state and flags while retaining their Permission. Original rows retain their lifecycle state.
Reset callbacks and released copy start states fail explicitly until their execution and release-date
initialization are supported. This internal copy reset runs even with `serverEvents="0"`.
Standalone copy actions, released relationship reset policies and native file-container/vault
copying remain unavailable; unsupported paths report their capability instead of pretending to copy.
`Morphae` links supply inherited polymorphic bindings with concrete item contexts. Own and inherited
bindings share `sort_order`; tied orders within an event version fail explicitly. Required bindings survive
`serverEvents="0"`. Native release-specific event and clone parity remains unverified.
