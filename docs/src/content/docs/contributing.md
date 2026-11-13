---
title: "Contributing"
---

```sh
bun install
bun run check
```

`check` runs formatting, readability lint, type checking, tests, and a clean package build. It writes framework results under `tests/results/`. Managed tests require .NET.

The core has no storage-driver, XML-parser, application, or transport imports. Framework implementation lives in `src/`; framework tests and generated results live in `tests/`, using the small test inputs in the root `.harness/`. Private consumer projects keep their own configuration, inputs, tests, and results outside the framework source. The managed C# helper and templates live beside their TypeScript adapter in `src/methods/csharp/managed/`. `scripts/` contains only the build and verification entry points.

`bun run release:check` packs the distribution, audits its contents and runs both examples
as fresh consumers of that archive.
The verified archive and check results are saved under `tests/results/`.
Published source maps include their framework TypeScript targets for debugging and declaration
navigation. The release check rejects missing sources and local build intermediates.

This is a 0.1 preview. See the compatibility guide for supported behavior and current limits.

## Work on the documentation

```sh
cd docs
bun install --frozen-lockfile
bun run build
bun run preview
```

The site builds to static files for GitHub Pages. Its packages and generated files stay separate from the framework distribution.
