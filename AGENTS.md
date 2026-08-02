# Repository Guidelines

## Project Structure & Module Organization

- `src/main/` contains the Electron main process, IPC handlers, settings, PTY, SSH, updater, and native bridge code.
- `src/preload/` exposes the typed renderer API; `src/renderer/` contains the React UI, components, hooks, i18n, and styles.
- `native/` is the Rust 2021 napi-rs module, with API, MCP, storage, and export layers under `native/src/`.
- `scripts/` holds build and release helpers; `resources/` holds application icons and static assets. Generated `out/`, `release/`, `native/target/`, and native `.node` files should not be edited.

## Build, Test, and Development Commands

Run `npm ci` after cloning to install the lockfile-pinned dependencies. Use `npm run dev` for Electron development with Vite HMR. `npm run check` runs TypeScript and Rust checks; `npm run check:ts` runs only TypeScript. `npm run build` compiles the Rust addon and production bundles. Use `npm run build:app` or the platform-specific `build:win`, `build:mac`, and `build:linux` scripts to create installers in `release/`.

## GitHub Actions Build and Test Policy

- Build and test acceptance must be completed by GitHub Actions. Do not use a local `npm run build`, `npm run check`, `cargo check`, `cargo test`, `electron-vite build`, or electron-builder result as completion evidence.
- The commands listed above describe the workflow steps and local development options; local execution may be used only for source inspection or narrowly scoped static diagnostics, not as a substitute for the required CI result.
- Before reporting completion, trigger or rerun the applicable workflow for the current commit and inspect its terminal result. A workflow that is queued, in progress, or merely triggered is not a successful build or test result.
- If an interrupted local build creates `out/`, `release/`, `native/target/`, or native `.node` files, remove those generated artifacts and do not edit or commit them.

## Coding Style & Naming Conventions

Follow the existing two-space TypeScript/JSON style and run Rust code through `rustfmt`. Keep TypeScript strict and preserve the existing Electron main/preload/renderer boundaries. Use `PascalCase` for React components and exported types, `camelCase` for functions and variables, `use*` for React hooks, and Rust `snake_case` for modules and functions. No repository-wide formatter or linter is configured, so keep imports, naming, and surrounding formatting consistent with nearby code.

## Testing Guidelines

There is currently no Jest, Vitest, Playwright, or npm `test` script, and no coverage threshold. Every change should pass `npm run check`; Rust-only changes can additionally use `cargo test --manifest-path native/Cargo.toml`. For UI, IPC, terminal, SSH, or updater changes, manually exercise the affected flow with `npm run dev` and record the scenario in the pull request.

## Commit & Pull Request Guidelines

Use concise imperative subjects. Existing history commonly uses `feat:` and `fix:` prefixes, while release commits use `v<version>` (for example, `v0.1.11`). Keep each commit focused. Pull requests should explain the problem, implementation, affected platforms, and verification commands; include screenshots or recordings for UI changes and call out configuration, migration, or release-artifact changes.

## Security & Configuration Tips

Never commit API keys, SSH credentials, local databases, or `.env` files. Keep local state under `.snow/`, review logs for secrets before sharing them, and avoid checking generated installers or native build outputs into source changes.
