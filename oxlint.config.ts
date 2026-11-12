import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

export default defineConfig({
    extends: [core],
    env: { builtin: true, browser: false, node: true },
    globals: { Bun: "readonly" },
    ignorePatterns: [
        ...(core.ignorePatterns ?? []),
        "tests/results/**",
        "workspaces/**",
        // Independent consumers install the packed package and run this linter in release:check.
        "examples/**",
        ".harness/local/**",
    ],
    jsPlugins: ["oxlint-plugin-complexity"],
    options: { typeAware: true },
    rules: {
        "complexity/complexity": ["error", { cognitive: 30, cyclomatic: 30 }],
        complexity: "off",
        // Domain order and named declarations make platform code easier to follow.
        "func-style": ["error", "declaration", { allowArrowFunctions: true }],
        "sort-keys": "off",
        "sort-vars": "off",
        // Transaction steps, event hooks and package actions must run sequentially.
        "no-await-in-loop": "off",
        // Native adapter contracts contain methods which do not need instance state.
        "class-methods-use-this": "off",
        "max-classes-per-file": "off",
        "no-use-before-define": ["error", { functions: false, classes: false }],
        // Constructor parameter properties keep ownership beside its declaration.
        "typescript/parameter-properties": ["error", { prefer: "parameter-property" }],
        // Method and callback variance is part of the existing extension contract.
        "typescript/method-signature-style": "off",
        "typescript/no-invalid-void-type": "off",
        // Nullable strings are often validated as nonempty; booleans remain explicit.
        "typescript/strict-boolean-expressions": [
            "error",
            { allowNullableString: true, allowNullableBoolean: true },
        ],
        "typescript/no-confusing-void-expression": ["error", { ignoreArrowShorthand: true }],
        // Promise-returning extension contracts may have synchronous implementations.
        "require-await": "off",
        "typescript/promise-function-async": "off",
        // Prefer readable steps over mandatory destructuring and expression rewrites.
        "prefer-destructuring": "off",
        "unicorn/no-await-expression-member": "off",
        "unicorn/import-style": "off",
        "unicorn/no-array-reduce": "off",
        // Keep independent lexical scopes, guard branches and owned work stacks readable.
        "no-shadow": "off",
        "no-negated-condition": "off",
        // Explicit Boolean conversions describe presence checks on native scalar metadata.
        "no-extra-boolean-cast": "off",
        // Settlement callbacks handle both outcomes without producing a new rejecting chain.
        "promise/prefer-catch": "off",
        "promise/always-return": "off",
        "promise/prefer-await-to-callbacks": "off",
        // Distinguish cleanupError, observerError and business failures by responsibility.
        "unicorn/catch-error-name": "off",
        "typescript/no-empty-interface": ["error", { allowSingleExtends: true }],
        "typescript/no-empty-object-type": ["error", { allowInterfaces: "with-single-extends" }],
        "no-plusplus": "off",
        "unicorn/no-negated-condition": "off",
        "unicorn/no-array-reverse": "off",
        "unicorn/no-array-sort": "off",
        "unicorn/no-object-as-default-parameter": "off",
        // Captures and Unicode matching can affect AML selectors and source scanning.
        "prefer-named-capture-group": "off",
        "require-unicode-regexp": "off",
        // Native callbacks and protocol responses require explicit Promise construction.
        "promise/avoid-new": "off",
        // Bit masks inspect compiler flags; delete removes actual AML properties.
        "no-bitwise": "off",
        "typescript/no-dynamic-delete": "off",
        // SAX exposes property callbacks rather than EventTarget listeners.
        "unicorn/prefer-add-event-listener": "off",
        // Runtime failures preserve the exact thrown value supplied by an extension.
        "typescript/prefer-promise-reject-errors": ["error", { allowThrowingUnknown: true }],
        "typescript/only-throw-error": ["error", { allowRethrowing: true }],
        // The structural checker measures physical lines and rejects unchecked casts.
        "max-lines-per-function": "off",
        curly: ["error", "all"],
        "no-nested-ternary": "error",
    },
    overrides: [
        {
            files: ["tests/**/*.ts"],
            rules: {
                // Bun's asynchronous rejects/resolves matchers are declared as returning void.
                "typescript/await-thenable": "off",
                "typescript/no-confusing-void-expression": "off",
            },
        },
    ],
});
