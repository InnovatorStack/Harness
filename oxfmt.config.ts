import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
    ...ultracite,
    tabWidth: 4,
    printWidth: 100,
    trailingComma: "all",
    embeddedLanguageFormatting: "off",
    proseWrap: "preserve",
    ignorePatterns: [
        ...(ultracite.ignorePatterns ?? []),
        "tests/results/**",
        "workspaces/**",
        ".harness/local/**",
        "docs/.astro/**",
        "docs/dist/**",
        // Package XML and original Method source are data, never formatter inputs.
        "**/*.xml",
        "**/*.aml",
    ],
});
