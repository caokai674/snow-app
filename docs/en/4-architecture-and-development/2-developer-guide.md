# Developer Guide

> For contributors: environment setup, common commands, directory responsibilities, the full implementation chain for new features, and coding conventions.
> See also: [Architecture Overview](1-architecture-overview.md), [Data Storage Locations](4-data-storage-locations.md).

## 1. Requirements

- **Node.js** >= 18 (20 LTS recommended)
- **Rust** stable toolchain + Cargo
- Platform requirements:
  - Windows: Visual Studio Build Tools (C++ workload) + ConPTY (auto-ensured)
  - macOS: Xcode Command Line Tools
  - Linux: `build-essential`, `pkg-config`, system SQLite (or bundled)

## 2. Common Commands

```bash
npm install                 # Install deps (postinstall patches spectre / ensures conpty.dll)

npm run dev                 # Dev mode (electron-vite dev, renderer hot reload)
npm run build:rust          # Compile Rust native module → snow_native.<platform>.node
npm run typecheck           # tsc --noEmit (must pass before committing)
npm run build               # build:rust + tsc --noEmit + electron-vite build
npm run build:app           # Full package (electron-builder)
npm run build:win           # Windows installers (nsis + portable)
```

> ⚠️ After changing `native/src/`, you MUST re-run `npm run build:rust` and
> **restart the app** (`.node` modules cannot be hot-swapped). Changes under
> `src/` are picked up by hot reload.

## 3. Directory Responsibilities

```
snow-app/
├── src/
│   ├── main/               # Electron main process (orchestration)
│   │   ├── app/            # bootstrap, windows, session proxy, tray, protocols
│   │   ├── ipc/handlers/   # IPC handlers (business orchestration)
│   │   ├── native/         # Rust bridge (nativeBridge.ts gate)
│   │   ├── pty/            # PTY terminal
│   │   ├── ssh/            # SSH / remote workspaces
│   │   ├── plugins/        # Plugin runtime (isolated workers)
│   │   ├── settings/       # Settings read/write
│   │   ├── snowCli/        # ~/.snow CLI compatibility
│   │   ├── updater/        # App updates
│   │   ├── codex/          # Codex compatibility layer
│   │   └── importConfig/   # Third-party config import
│   ├── preload/
│   │   ├── index.ts        # contextBridge.exposeInMainWorld("snow", api)
│   │   ├── modules/        # One *Api.ts per domain (ipcRenderer.invoke)
│   │   └── types/          # Cross-layer shared types
│   └── renderer/
│       ├── components/     # Sidebar / main content / right panel
│       ├── hooks/          # Custom hooks (useAgentLoop etc.)
│       ├── i18n/lang/      # zh-CN.ts / en.ts / zh-TW.ts (must stay in sync)
│       └── utils/          # Frontend utilities
├── native/                 # Rust native layer (capability layer)
│   └── src/
│       ├── exports/        # napi export entries (*.rs per domain)
│       ├── api/            # AI provider adapters (anthropic/gemini/responses/chat)
│       ├── mcp/            # MCP servers (servers/) + external client (external/)
│       ├── prompt/         # System prompts
│       └── storage/        # SQLite (database.rs / migrations.rs / services/)
├── scripts/                # Build & utility scripts (build-native.cjs etc.)
├── resources/              # Icons & static assets
└── docs/                   # Docs (guides + reference + architecture & development)
```

## 4. Full Chain for Adding a Feature

Using "add a settings item" as an example — the cross-layer change pattern:

```
① Renderer (UI)
   src/renderer/components/sidebar/xxxSettingsPanel.tsx    # form UI
   src/renderer/i18n/lang/{zh-CN,en,zh-TW}.ts               # three-language copy

② Preload (types + channel)
   src/preload/types/xxx.ts                                 # type definitions
   src/preload/modules/xxxApi.ts                            # ipcRenderer.invoke("xxx:get")
   src/preload/index.ts                                     # register on window.snow
   src/preload/types/index.ts                               # export types

③ Main (IPC handler)
   src/main/ipc/handlers/xxxHandlers.ts                     # ipcMain.handle("xxx:get", ...)
   src/main/ipc/registerIpcHandlers.ts                      # register handler

④ Native (Rust capability)
   native/src/storage/services/xxx.rs                       # SQL access layer
   native/src/exports/storage.rs                            # napi export
   (or native/src/api/, native/src/mcp/servers/ per domain)

⑤ Build & verify
   npm run build:rust   # required after Rust changes
   npm run typecheck    # no `any`, must pass
```

**Read-only query chain**: Renderer → `window.snow.xxxApi` →
`ipcRenderer.invoke` → `ipcMain.handle` → `native.xxx` (storageReady gate
auto-waits) → rusqlite.

## 5. Coding Conventions

### Mandatory

- **No `any` types**: `tsc --noEmit` must pass (CI red line for this project).
- **Three-language sync**: any UI copy change updates `zh-CN.ts` / `en.ts` /
  `zh-TW.ts` together.
- **Rust code**: keep `cargo fmt` style; new SQL goes through the existing
  `storage/services/` pattern.
- **Database changes**: new table → `database.rs::create_schema`; new column →
  post-schema migration in `migrations.rs` (must be idempotent) + bump `user_version`.

### Design Constraints

- The renderer must **never** require Node modules directly (always via `window.snow.*`).
- Main-process native calls must **not** bypass `nativeBridge` (except during
  initialization — see `bootstrap.ts` comments: raw binding avoids the
  storageReady deadlock).
- New MCP tools should follow the parameter-description style of existing
  servers in `native/src/mcp/servers/` (schemas are exposed to AI models —
  describe constraints and defaults precisely).
- File edits follow workspace conventions: prefer apply_patch/filesystem
  tools; shell commands use PowerShell syntax (Windows default environment).

## 6. Common Pitfalls

| Issue | Notes |
|-------|-------|
| Native changes don't take effect | Forgot `npm run build:rust` or didn't restart (`.node` can't hot-swap) |
| storageReady deadlock | Calling native before init without the Proxy — only bootstrap may use the raw binding |
| tsc can't find a module | Run `npm install` after adding deps; commit lockfile changes with the PR |
| Missing translation | The three i18n files must stay structurally identical; missing keys show `undefined` at runtime |
| CRLF warnings | Git CRLF→LF notices on Windows are normal (repo is LF-normalized) |
| DB migration failure | Migrations must be idempotent; verify on a backup DB before committing |

## 7. Commit Conventions

- Conventional Commits: `feat:` / `fix:` / `docs:` / `refactor:` / `chore:`
- Syncing upstream: `git fetch upstream && git merge upstream/main`, resolve conflicts locally
- Never commit: `out/`, `release/`, `node_modules/`, `.tmp-*.cjs`, user data dirs
