# Basic example

Install Bun 1.4.4.
Then run in this directory:

```sh
bun install
bun test
```

The package defines `ExampleDocument`; fixtures supply its starting record. The test
updates it, reads the saved value and resets to the original state. Configuration is optional.
This example uses no C# execution or server connection.
