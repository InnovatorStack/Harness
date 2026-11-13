---
title: "Mock a dependency"
---

Harness automatically loads `.harness/mocks.json`. Configure only the calls whose results you want to replace:

```json
[
    {
        "method": "ReadRequests",
        "when": { "state": "Open" },
        "response": "./responses/requests.json"
    }
]
```

Response paths resolve beside the declaring JSON file. JSON files return JSON in the native Result; `.txt` files return text; AML/XML files return Items. Inline responses accept `{ json: data }`, `{ text: value }`, `{ aml: xml }`, `{ error: message }`, or an explicit Item.

## Override a call in a test

Tests can override individual calls while retaining other shared responses:

```ts
using harness = await createHarness({
    mocks: [
        {
            method: "ReadRequests",
            when: { state: "Open" },
            response: { json: { requests: [] } },
        },
    ],
});
```

An empty `mocks: []` disables shared responses. Configuration can supply `mocks: ["./other-mocks.json"]` instead of the conventional file. Local overrides take precedence for matching calls. Within a layer, the most specific property match wins; equally specific matches fail explicitly. Method names match case-insensitively, and property values match exactly.

The same dispatch handles direct calls, nested calls, and imported events. Matching calls skip source execution and C# compilation; unmocked calls execute normally. Responses are isolated per invocation and world. Traces label mocks and include their arguments, declaration, response file, and hash.

Mocked before/after hook responses supply callback output; they do not patch the shared event input.

## SQL boundaries

`sql: "ReadDocuments"` matches a named SQL definition. `sql: true` matches inline SQL; `when.method` identifies the Method making that call. The response replaces that boundary only. It does not add fixture records or prove the replaced SQL executed.

Unmatched SQL fails explicitly; Harness does not include a general SQL engine.
