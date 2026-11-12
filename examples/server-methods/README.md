# Server Methods example

Install the .NET 10 SDK and build the archive using the [installation steps](../../README.md).
Then run in this directory:

```sh
bun add --dev ../../innovatorstack-harness-0.1.0.tgz
bun test
```

The original example export defines `SubmitReview` and its `onBeforeUpdate` guard.
Tests verify permitted changes, a protected approval date and rollback after a failed save.
Only `ReadReviewRules` is mocked; the submit Method and guard execute their C# source.
All names, records and source in this example were written for Harness.
