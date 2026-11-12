# Basic example

Build and pack Harness at the repository root using the [installation steps](../../README.md).
Then run in this directory:

```sh
bun add --dev ../../innovatorstack-harness-0.1.0.tgz
bun test
```

The package defines `ExampleDocument`; fixtures supply its starting record. The test
updates it, reads the saved value and resets to the original state. Configuration is optional.
This example uses no C# execution or server connection.
