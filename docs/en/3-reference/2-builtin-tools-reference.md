# 2-builtin-tools-reference

Snow App ships with a set of built-in MCP tools that let the AI agent perform file operations, terminal commands, web search, browser automation, and more. This article lists all built-in servers and tools.

## 1. Tool Naming Convention

Built-in tool full names follow the pattern `{server-id}-{tool-name}`, e.g. `filesystem-read`. Some server IDs contain `-` (e.g. `user-interaction`); when resolving the tool name, the built-in server list is used for **longest-prefix matching** to disambiguate.

## 2. Server Overview

Listed in registration order:

| Server ID | Description |
| --- | --- |
| `filesystem` | Local file read/write (read / replace_edit / create) |
| `bash` | Terminal command execution |
| `todo` | Session task list management |
| `grep` | File content search (ripgrep) |
| `websearch` | Web search and page fetching |
| `browser` | Built-in browser automation (embedded Electron browser) |
| `user-interaction` | Ask the user questions (blocking interaction) |
| `sub-agents` | Activate sub-agents to run tasks independently |
| `codebase` | Codebase semantic search (embedding index) |
| `codelens` | Code diagnostics and symbol location |
| `app-control` | App control (memos / modes / settings pages / scheduled tasks / projects) |
| `config` | Read/write global config (files: settings/snowcfg/proxy/app/custom-headers/system-prompt/theme/language/permissions/lsp-config/buddy; database: subAgents/hooks; delegated: skills) |
| `skills` | Skill loading and execution |

## 3. Tool Details

### filesystem

| Full tool name | Purpose | Key parameters |
| --- | --- | --- |
| `filesystem-read` | Read file content (supports text, images, Office documents) | `filePath`, `startLine`, `endLine` |
| `filesystem-replace_edit` | Fuzzy search-and-replace editing | `filePath`, `searchContent`, `replaceContent`, `occurrence` |
| `filesystem-create` | Create a new file (auto-creates parent directories) | `filePath`, `content`, `overwrite` |

### bash

| Full tool name | Purpose | Key parameters |
| --- | --- | --- |
| `bash-terminal-execute` | Execute terminal commands (build, test, package management, etc.) | `command`, `description`, `workingDirectory`, `timeout` |

### todo

| Full tool name | Purpose | Key parameters |
| --- | --- | --- |
| `todo-todo-manage` | Session task list management (CRUD) | `action`, `content`, `sessionId`, `status`, `todoId`, `parentId` |

### grep

| Full tool name | Purpose | Key parameters |
| --- | --- | --- |
| `grep-search` | Search file contents with ripgrep | `pattern`, `path`, `fileGlob`, `caseSensitive`, `isRegex`, `maxResults` |

### websearch

| Full tool name | Purpose | Key parameters |
| --- | --- | --- |
| `websearch-websearch-search` | Web search, returns a list of results | `query`, `maxResults` |
| `websearch-websearch-fetch` | Fetch and read the full content of a web page or an image | `url`, `maxLength`, `isUserProvided`, `userQuery` |

### browser

| Full tool name | Purpose | Key parameters |
| --- | --- | --- |
| `browser-create` | Create an embedded browser instance | `url` |
| `browser-navigate` | Navigate to the specified URL | `url`, `timeoutMs`, `instanceId` |
| `browser-click` | Click page elements with real mouse events | `selector`, `text`, `exact`, `instanceId` |
| `browser-evaluate` | Evaluate arbitrary JavaScript in the page and return the result | `expression`, `instanceId` |
| `browser-type` | Type text into an element (set at once or key by key) | `selector`/`text`, `value`, `submit`, `delayMs`, `instanceId` |
| `browser-screenshot` | Capture the page as PNG | `fullPage`, `instanceId` |
| `browser-devtools` | Page snapshot / console messages (level-filterable) / network requests / dialog handling / open DevTools | `action`, `level`, `filter`, `limit`, `dialogResponse`, `instanceId` |
| `browser-close` | Close a browser tab | `instanceId` |
| `browser-focus` | Switch to the specified tab | `instanceId` |
| `browser-list` | List all open tabs | — |

### user-interaction

| Full tool name | Purpose | Key parameters |
| --- | --- | --- |
| `user-interaction-askUserQuestion` | Ask the user a question (blocking interaction; must be called alone) | `question`, `options` |

### sub-agents

| Full tool name | Purpose | Key parameters |
| --- | --- | --- |
| `sub-agents-activate` | Activate a sub-agent to run a task independently | `agentId`, `prompt` |

### codebase

| Full tool name | Purpose | Key parameters |
| --- | --- | --- |
| `codebase-search` | Codebase semantic search (embedding index based); **only exposed when the project has codebase indexing enabled and an index has been built** | `pattern`, `path`, `fileGlob`, `maxResults` |

### codelens

| Full tool name | Purpose | Key parameters |
| --- | --- | --- |
| `codelens-diagnose` | Run code diagnostics, returns syntax/semantic errors | `filePath` |
| `codelens-find_definition` | Find a symbol's definition location | `filePath`, `line`, `column` |
| `codelens-find_references` | Find a symbol's reference locations | `filePath`, `line`, `column` |
| `codelens-file_outline` | Get a file's symbol outline | `filePath` |

### app-control

| Full tool name | Purpose | Key parameters |
| --- | --- | --- |
| `app-control-createMemo` | Create a memo (note) | `content` |
| `app-control-setMode` | Enable/disable Plan Mode or Goal Mode | `mode`, `enabled` |
| `app-control-openSettings` | Open the specified settings page | `page` |
| `app-control-createScheduledTask` | Create a scheduled task | `name`, `prompt`, `schedule` |
| `app-control-createProject` | Create a project (workspace directory) | `name`, `parentPath` |
| `app-control-requestApproval` | Request user approval of the plan summary (only exposed in Plan Mode) | `planSummary` |

### config

| Full tool name | Purpose | Key parameters |
| --- | --- | --- |
| `config-list` | List manageable scopes (settings/snowcfg/proxy/app/custom-headers/system-prompt/theme/language/permissions/lsp-config/buddy/subAgents/hooks/skills) and their keys; pass `scope` to inspect a single scope with current values (sensitive keys masked) | `scope`, `projectId` |
| `config-get` | Read a key's value; sensitive keys (`apiKey`, `visionApiKey`, custom-header schemes, system-prompt prompts) are always masked; `subAgents`/`hooks` scopes read directly from the app database | `scope`, `key`, `projectId` |
| `config-set` | Write a key (whitelist + type check + auto backup + atomic write); `settings.mcpServers` auto-syncs to the app database and takes effect immediately; `subAgents`/`hooks` scopes write directly to the app database and take effect immediately | `scope`, `key`, `value`, `projectId` |
| `config-delete` | Delete a key; `subAgents`/`hooks` scopes delete database records directly | `scope`, `key`, `projectId` |

> **Structural validation**: `settings.codebase`, `custom-headers.schemes`,
> `system-prompt.prompts` and `lsp-config.servers` are deeply validated on
> write (known fields are type-checked one by one, e.g.
> `codebase.embedding.dimensions` must be a number) so an agent cannot corrupt
> nested fields; unknown fields are allowed through for forward compatibility.
>
> **Project-scoped settings**: passing `projectId` to the `settings` scope's
> `mcpServers` / `sensitiveCommands` reads/writes **project-level** config
> (app database, takes effect immediately, same source as the UI project
> settings): `mcpServers` is a full replace (value is
> `{name: {type,url,command,args,env,headers,enabled,timeoutMs}}`);
> `sensitiveCommands` is a full replace (value is an array of
> `{commandId, pattern, description, enabled}`; a commandId matching a global
> rule becomes an enabled override, others become project custom rules);
> all other keys reject `projectId` with a clear error.

File-backed scopes:

| Scope | File | Main keys |
| --- | --- | --- |
| `settings` | `~/.snow/settings.json` | `mcpServers`, `codebase`, `sensitiveCommands`, `yoloMode`, `planMode`, ... |
| `snowcfg` | `~/.snow/config.json` (`snowcfg` object) | `baseUrl`, `apiKey` (sensitive), `advancedModel`, `chatThinking`, `responsesReasoning`, `maxTokens`, ... |
| `proxy` | `~/.snow/proxy-config.json` | `enabled`, `host`, `port`, `searchEngine`, `browserPath`, `browserDebugPort` |
| `app` | `~/.snow/active-profile.json` | `activeProfile` |
| `custom-headers` | `~/.snow/custom-headers.json` | `active`, `schemes` (sensitive — may contain Authorization headers) |
| `system-prompt` | `~/.snow/system-prompt.json` | `active`, `prompts` (sensitive — prompt body) |
| `theme` | `~/.snow/theme.json` | `theme`, `simpleMode`, `diffOpacity`, `toolDisplayMode`, `thinkDisplayMode`, `subAgentDisplayMode`, `toolIcons`, `customColors` |
| `language` | `~/.snow/language.json` | `language` |
| `permissions` | `~/.snow/permissions.json` | `alwaysApprovedTools` |
| `lsp-config` | `~/.snow/lsp-config.json` | `schemaVersion`, `servers` |
| `buddy` | `~/.snow/buddy.json` | `version`, `companion`, `muted` |

Database-backed scopes (write to the app SQLite database, same source as the UI settings panels, take effect immediately):

| Scope | key | value | Notes |
| --- | --- | --- | --- |
| `subAgents` | `agentId` | `{name, description?, systemPrompt?, toolsJson?, configProfile?}` | Create/update a sub-agent; `toolsJson` accepts a JSON string or an array of tool names; the built-in `agent_general` cannot be modified/deleted; omit `projectId` for global, provide it for project-scoped |
| `hooks` | `hookType` | `{rules: [{description, matcher?, hooks: [{type, command?, prompt?, content?, timeout?, enabled?}]}]}` | Configure lifecycle hooks; omit `projectId` for global, provide it for project-scoped (project overrides global) |

Delegated scope (reuses the skill-management service SkillsConfigService; storage semantics identical to the UI):

| Scope | key | value | Notes |
| --- | --- | --- | --- |
| `skills` | `skillId` | `{enabled}` toggles / `{url, location}` installs from GitHub | Global toggle rewrites the `enable` field in SKILL.md frontmatter; project toggle writes a DB `skill_overrides` record; install/uninstall operate on `~/.snow/skills` directories and `skills-registry.json`; `projectId` scopes to a project |

Read-only log scope (lets the agent self-diagnose app anomalies without a human reading logs):

| Scope | key | Notes |
| --- | --- | --- |
| `logs` | Log file name (e.g. `2026-08-03-error.log`) or a level shortcut (`error`/`warn`/`info`/`debug` for today's file) | `config-list logs` lists all log files under `~/.snow/log` (newest first, with size/level) plus the latest error-file summary; `config-get logs` reads the file tail (optional `limit`, default 200, max 2000, ring-buffer avoids loading large files); `config-set logs` is read-only; `config-delete logs` only accepts an exact file name (path-traversal safe) |

> Configuration examples: see [2-guides/5-configure-hooks-and-subagents](../2-guides/5-configure-hooks-and-subagents.md).

### skills

| Full tool name | Purpose | Key parameters |
| --- | --- | --- |
| `skills-skill-execute` | Load and execute the specified skill | `skill` |

> Note: the frontmatter field that controls the toggle is `enable` (not `enabled`).
> The former `skills-config-*` tools (list/setEnabled/installGithub/uninstall)
> have been removed; skill management now uses the `config` server's `skills`
> scope exclusively (see above).

## 4. Special Notes

**Valid values for the `page` parameter of `app-control-openSettings`:**

| page value | Corresponding settings page |
| --- | --- |
| `api-settings` | API Settings |
| `proxy-browser-settings` | Proxy & Browser |
| `codebase-settings` | Codebase Settings |
| `system-prompt-settings` | System Prompts |
| `custom-headers-settings` | Custom Headers |
| `mcp-settings` | MCP Settings |
| `skills-settings` | Skills Settings |
| `sub-agent-settings` | Sub-Agent Settings |
| `sensitive-command-settings` | Sensitive Commands |
| `hooks-settings` | Hooks Settings |
| `theme-settings` | Theme Settings |
| `terminal-settings` | Terminal Settings |
| `keyboard-shortcuts-settings` | Keyboard Shortcuts |
| `privacy-settings` | Privacy Settings |
| `usage-settings` | Usage Settings |
| `system-logs` | System Logs |

**Other notes:**

- `app-control-requestApproval` is only exposed when Plan Mode is enabled;
- `skills-skill-execute` dynamically loads enabled skills from `~/.snow/skills` and the project's `.snow/skills`.

## 5. Difference from External MCP Tools

External MCP server tools are added by the user in **MCP Settings** (see [2-guides/1-configure-mcp](../2-guides/1-configure-mcp.md)); their tool names are prefixed with the server name (e.g. `dbx-search_context`), distinguishing them from built-in tools via prefix matching against the built-in server list.
