---
title: Lifecycles and classification
---

Lifecycle bindings, states, transitions, and pre/post Methods come from imported AML. `add` uses the start state; `promoteItem` validates the transition and updates `state` and `current_state` without creating another generation. Transition roles require the configured authorization policy or the existing explicit `authorization: "unchecked"` setting. Transactional pre/post Methods execute through the same Method dispatcher and configured mocks.

Assigned classifications must be imported leaf paths or the unclassified root. Branches can
grant Can Add to their descendants. Native authorization checks the target class after before
hooks; an unchanged class needs no new creation grant. Changing lifecycle maps requires the
old map's start state, while class changes within the same map retain their current state.
Resets apply the new state's Permission before nested actions, then update state and owned
relationship behavior transactionally. Explicit `version` resets a released item before its
class update; ordinary edit/update validates against the previous lifecycle first.

When the imported schema requires `created_on` or `created_by_id`, normal `add` supplies omitted values from the current time and configured User session. Supplied values and fixture audit data remain intact. This covers required creation defaults; complete audit permission and modification policies remain separate work.
