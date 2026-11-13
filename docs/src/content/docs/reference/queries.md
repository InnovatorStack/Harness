---
title: "AML queries"
---

Queries accept native `<and>`, `<or>`, `<not>`, repeated property conditions, comparisons,
`like`/`not like` (`%` and `_`), `in`/`not in`, `between`/`not between`, and null tests.
`where` accepts the same property-to-literal predicates with parentheses and qualified identifiers.
Values are bound separately from SQL. Decimal comparisons preserve text precision; dates preserve
up to seven fractional digits. Text matching is case-sensitive; item IDs are case-insensitive.
Installation-specific SQL Server collation and LIKE bracket classes remain unsupported.

`orderBy` runs before `page`/`pagesize` and `maxRecords`. Native `itemmax` and `pagemax` metadata
is available in `result.payload.messages` and C# response XML, including empty pages. Query work
is bounded to 512 predicates, 64 nesting levels, 10,000 values and 100,000 candidate rows.
Native release comparisons are still pending.

Nested relationship gets hydrate each parent's collection. Criteria filter parents before paging;
`isCriteria="0"` only hydrates. Nested item-property get/add/edit/update and relationship
add/edit/update/delete run through normal events in one transaction. Relationship mutations use
explicit child IDs. When a parent versions, those IDs resolve to the copied relationships,
leaving historical rows intact. Invalid ownership or a failed child action rolls back the graph.

## Responses

For add/edit/update, native AML `doGetItem="0"` returns type-and-ID Items after saving and running
mutation hooks. Full responses run Get after those hooks; its calculated properties, permissions
and failures participate in the same transaction. Fetch relationships explicitly when needed.
Lock/unlock with `doGetItem="0"` return the message `Ok.`; delete returns `Ok`. These messages
contain no Items. The flag does not suppress ordinary Get requests. Nested mutations default to
minimal responses unless their ItemType declares an after-mutation handler; explicit flags override
that default. Replacement Methods retain control of their own responses.
