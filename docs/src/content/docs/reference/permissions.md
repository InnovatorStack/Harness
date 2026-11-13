---
title: Permissions
---

Permission checks use imported users, identities and access rules. Enable them in shared configuration:

```ts
import { AuthorizationMode } from "@innovatorstack/harness";
import type { HarnessConfig } from "@innovatorstack/harness";

export default {
    authorization: AuthorizationMode.Native,
    session: { user: { login_name: "test_user" } },
} satisfies HarnessConfig;
```

The session selector must resolve an imported User. Supply the solution's User, Alias, Member, Permission/Access, Allowed Permission and Can Add data through packages and fixtures.

## What gets checked

| Operation               | Rule                                                            |
| ----------------------- | --------------------------------------------------------------- |
| Get                     | Inaccessible records are filtered before paging.                |
| Add                     | Can Add applies to the final classification after before-hooks. |
| Edit, update and delete | The record's imported access rules apply.                       |
| Ordinary Method calls   | `execution_allowed_to` applies.                                 |
| Promotion               | The transition's roles apply.                                   |

Owner, Manager and Creator resolve per record. Team roles use that record's `team_id` and Team Identity membership. These roles do not become global session identities. Membership dates use the world's controlled clock.

## Scoped execution

Bound server-event Methods use native `NoCheck` for Method execution identities, including nested Method calls in that chain. Item permissions and transition roles still apply. Lifecycle pre/post Methods inherit that scope when promotion descends from a bound hook.

C# `CCO.Permissions.GrantIdentity` grants expire when the invocation finishes, including exceptions and timeouts. Scope does not pass to concurrent siblings or other worlds.

## Inherited relationships

An inherited relationship copies its source's Permission, owner, manager and Team; its Creator stays with the relationship. Creation needs source Update access. Direct edits and deletion use the copied Update right.

Changes to source security propagate transactionally through inherited relationships, including lifecycle changes and new generations. Historical generations retain their ACLs. Propagation does not run business hooks. An authorized parent deletion removes owned rows without granting those rights to nested Methods.

Fixtures retain the supplied ACL values; reads do not repair them. Related Items keep their own permissions.

## Other policies and limits

`AuthorizationMode.Unchecked` selects behavior-only execution; custom policy callbacks remain available. Restricted operations require an explicit policy, and missing native ACL metadata fails setup or execution.

Moving inherited relationships, `for_all` source resolution, discovery and ABAC/MAC are unavailable. Native release-specific permission parity is unverified.
