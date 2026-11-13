# Server Methods example

Install Bun 1.4.4 and the .NET 10 SDK.
Then run in this directory:

```sh
bun install
bun test
```

The original example export defines `SubmitReview` and its `onBeforeUpdate` guard.
Tests verify permitted changes, a protected approval date and rollback after a failed save.
Only `ReadReviewRules` is mocked; the submit Method and guard execute their C# source.
`.harness/config.ts` maps `SubmitReview` to `src/SubmitReview.cs`. Edit that file and rerun the
tests. The imported package retains its Method identity and guard binding; the export stays unchanged.
All names, records and source in this example were written for Harness.
