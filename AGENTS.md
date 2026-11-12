# Harness

Harness is a standalone TypeScript framework for running applications against a local, instrumentable test environment. It is a library, not a hosted service. Bun is the only runtime target, package manager, and test runner. Do not add Node.js compatibility targets or portability layers.

## Engineering standards

- Write clean, readable, maintainable code. Prefer proven, simple patterns over cleverness or speculative abstractions.
- Prioritize human readability: use explicit blocks, descriptive names, whitespace between logical steps, and ordinary control flow. Avoid nested ternaries and compressed generated-source strings. Keep managed source and project templates in readable files.
- Preserve locality of behaviour: keep a feature's implementation, types, and validation together. Framework tests live under `tests/`. Private consumer workspaces are isolated projects under the Git-ignored `workspaces/` directory, each owning its setup, inputs, tests, helpers, and results. Keep archived workspaces there as well.
- Keep modules highly cohesive and loosely coupled. Share computation only when the responsibility is genuinely shared; do not create generic utility layers merely to remove a few repeated lines.
- Keep dependencies explicit. The core must not import SQLite, XML parsers, application packages, or transport adapters.
- Prefer native Bun APIs when available, including `Bun.file`, `Bun.write`, `Bun.CryptoHasher`, and `Bun.fileURLToPath`. Do not import Node equivalents unnecessarily. Use Bun's implemented filesystem APIs only for operations without a suitable native Bun API; do not invent replacements for proven filesystem primitives.
- Use strict TypeScript, descriptive names, narrow interfaces, and explicit public exports. Avoid `any`, unchecked casts, and silent fallback behaviour.
- Make unsupported behaviour fail with an actionable diagnostic. Never substitute a mock or skip required platform behaviour silently.
- Keep solution-specific names and rules out of framework code. Projects supply their own packages and package dependencies; do not discover, download, or invent them.
- Remote Aras access for this work is read-only. Use only connection inspection and `action="get"` queries; never mutate remote items or invoke remote custom Methods. Compilation, seeding, actions, and Method tests run locally against the harness.
- Consumer package and Method source files are read-only. Execute their original `method_code` unchanged inside the executor template; record source hashes. Fix runtime compatibility in Harness rather than patching the supplied business source to make a test pass.
- Preserve source provenance and deterministic import order. Package loading must be atomic.
- Write meaningful tests for observable contracts, failure paths, transaction isolation, and regressions. Keep framework tests under the root `tests/`, with ignored results under `tests/results/`. Application-specific tests and results belong entirely inside their example project.
- Run formatting, type checking, tests, and the package build before delivering changes.

## Coding style contract

Follow [TigerStyle](https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/TIGER_STYLE.md)
with explicit TypeScript/Bun and managed-adapter conventions. Readability is a design constraint,
not a formatting pass at the end. Do not claim that linting proves complete TigerStyle compliance.

- Use 4 spaces and a 100-column code measure. Preserve embedded AML, original Method source,
  regular expressions and literal data; check the surrounding code rather than rewriting their
  contents. C# source has a hard 100-column limit.
- Keep functions, methods, constructors, accessors and executable callbacks within 70 physical
  lines, including their signature. Only imported Bun `describe` registration callbacks are
  exempt; their nested hooks, helpers and test bodies are still checked.
- Use braces for control flow. Avoid nested ternaries, implicit or explicit `any`, non-null
  assertions and unchecked casts. Simple conditional values may use a ternary; control flow and
  multi-step decisions need ordinary branches. Preserve the reviewed TypeScript API and native
  Aras method names instead of imposing Zig naming conventions on consumers.
- Cognitive complexity is capped at 30 by the Oxlint complexity plugin. This is a project
  guardrail, not a TigerStyle number. Split by domain responsibility before reaching the cap; do not hide complexity in
  callbacks or build collections of tiny helpers merely to satisfy a counter.
- Separate control-flow phases, final results and methods with blank lines. The AST layout check
  enforces this spacing; never remove whitespace to satisfy the function-length limit.
- Put state and control flow where their lifecycle can be understood. Keep variables in the
  smallest useful scope. Use descriptive names, named limits and units on quantities. Comments
  should explain constraints and decisions, not narrate obvious statements.
- Prefer explicit work stacks for tree and dependency traversal. Review bounds on input sizes,
  nesting, queues and external work. A linter cannot establish those bounds or prove that dynamic
  Method dispatch terminates. Owned interpreter paths use explicit bounded work stacks. Native
  library traversal and user-supplied code retain their own execution boundaries.
- Validate operating inputs and assert internal invariants where they are known. Do not insert
  dummy assertions to meet a density target. Bun's allocation model and async execution are
  deliberate language adaptations, not claims of Zig's static-allocation guarantees.
- `bun run format` and `bun run format:check` cover framework TypeScript/configuration and owned
  C# source. `bun run lint` combines Ultracite/Oxlint with AST checks for TypeScript and managed source,
  including the Method template with placeholder code. Never style-check injected customer
  Method code. Never exclude a framework source file to make the checks pass.
- Keep source, scripts, tests and shared setup in type/style coverage. The checker rejects owned
  TypeScript files omitted from `tsconfig.json`. Generated output, dependencies, test results and
  private consumer workspaces are excluded; those are not framework source.
- Public examples are independent consumer projects. `bun run release:check` installs the packed
  package into isolated copies, then applies strict types, Oxlint, TigerStyle AST checks and tests
  to each example and the skill's maintained code examples. Root lint does not assume these
  consumers have local dependencies installed.
- `bun run check` and CI must pass formatting, lint, types, tests and build. Keep negative tests
  that prove these checks reject violations. Changes to this contract require a reason; do not
  silently loosen a rule when a file fails it.

## Developer experience

- Projects use a shared harness configuration with overrides per suite or test.
- Consumer projects keep Harness configuration, package inputs, references, and optional shared seed data in `.harness/`. Test files and project-owned test helpers stay outside `.harness/` in their normal locations.
- Shared configuration loads fixture data from `.harness/fixtures` before tests run. Ordinary tests and application code query records already in the database. Do not require manual `seed` calls, fixture handles, or record-construction boilerplate in consumer tests. Low-level seed operations remain engine/extension capabilities, not the default authoring workflow.
- Package exports are the source of truth for schema, relationships, Method/SQL source, event bindings, lifecycle definitions, and execution ordering. Do not make consumers transcribe those definitions into configuration, SQL setup scripts, ID maps, or mock business handlers.
- Fixtures mean scenario seed data. Accept values for the imported schema, generate IDs, and connect returned record references automatically; consumers must not redefine schema or event wiring. Support packaged data exports as another input. Do not require hand-written SQLite setup or a parallel data model.
- Distinguish fixture seeding from business actions: setup may write validated starting records without normal action hooks; callers use normal platform actions when they want creation/update logic to execute.
- Resolve imported records by meaningful keys or retain references returned by the application/runtime. Consumers must not maintain copied internal IDs in test constants.
- Review material consumer-facing API and test-syntax decisions with the user using concrete examples before implementing them. The existing scaffold API is provisional.
- Design normal test authoring around application actions, source data, and observable outcomes. Internal operation registration and storage construction must not become required ceremony for ordinary tests.
- Keep module extension contracts separate from the default consumer experience. Preserve access to instrumentation and advanced controls without requiring every test to configure them.
- Shared call mocks live in `.harness/mocks.json` or configured JSON inputs. Per-test overrides apply only to matching calls; everything else executes normally. Mock matching happens centrally for direct, nested, event, and SQL calls, before source compilation. Never require a mocked dependency's implementation or proprietary assembly merely to return its configured response.
- Keep mocked responses separate from stored fixture records. Trace mock inputs and response provenance explicitly; do not present mocked SQL results or compilation checks as execution of the underlying business logic.
- Application compatibility checks belong inside their consumer example, including XML inspection, source hashes, and reporting helpers. Do not spread an example across framework configuration, tests, scripts, or results. Examples must consume the library through public package exports, without relative imports into framework `src/` or path aliases that bypass the package.
- Account for every Method and SQL definition in package compatibility work. Distinguish inventoried, compiled, and behaviorally verified source. Framework unit-test counts and a few passing Methods never establish whole-package support.

## Scope

Keep the current consumer experience library-only. Load ordinary exports and fixtures directly; do not introduce preparation scripts or a CLI without an explicit user request and API review.

The consumer entry point is asynchronous `createHarness()`. It discovers shared `.harness/config.ts` or conventional package/fixture inputs and returns an isolated world after setup completes. Consumer tests use normal `bun:test` and query existing database records. Low-level composition lives behind the separate `engine` import; it must not become required test boilerplate.

The implementation covers configured setup, TypeScript and AML fixtures, the modular runtime, SQLite storage, AML package loading, schema-driven seeding, a bounded action/event pipeline, automatic/manual generations, User-owned locks, imported lifecycle transitions, and an optional .NET-backed C# source executor. The managed adapter uses the installed .NET 10 SDK and a pinned Newtonsoft.Json NuGet dependency. JavaScript and T-SQL execution are not implemented. Imported major-revision sequences and released-item lifecycle resets are supported. Minor revision policies, released relationship cloning and wider reference profiles remain separate work. Supported collection events, Morphae inheritance and current versionable relationship cloning are metadata-driven platform behavior; native parity remains unverified. Supported fixed/floating policies and dependent-item cleanup are owned by the platform reference services. Loading or compiling a package does not establish compatibility with every Aras runtime behaviour.

Continue building the instrumentable platform layer through source-backed Method/action scenarios. Browser hosting and full UI end-to-end tests are deferred. Do not make a general T-SQL interpreter a prerequisite for SQL-free scenarios. Keep platform authority in TypeScript. Use the root README for the framework, `tests/README.md` for framework verification, and each example's README for its setup and compatibility scope; avoid duplicate guides.

Keep the managed C# helper beside its adapter in `src/methods/csharp/managed/`; the build copies those resources into `dist`. Each project owns its `.harness/` configuration and inputs. Keep private package paths, metadata, caches, and results ignored. Root `bun run check` verifies only the framework and writes `tests/results/README.md`. Each example runs its own checks independently and keeps its own results.

Do not copy proprietary solution packages into this repository. Use small, original fixtures and keep application input paths local.

Public source and distributed assets must not contain organization or environment identifiers, workstation paths, backup filenames, or private captures. Keep application workspaces local and ignored. Built-in data contains only reusable standard platform metadata.
