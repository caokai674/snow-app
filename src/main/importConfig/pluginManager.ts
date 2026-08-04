import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFile } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { mkdtempSync } from "node:fs";
import type { ImportCommitItemResult, ImportProvider, ImportScope } from "../../shared/importDiscovery";
import type { ImportResourceInput } from "../../shared/importResources";
import type {
  PluginComponentInput,
  PluginComponentRecord,
  PluginInput,
  PluginMarketplaceCatalog,
  PluginMarketplacePlugin,
  PluginMarketplaceRecord,
  PluginMarketplaceSourceType,
  PluginRecord,
  PluginRuntimeDeclaration,
  PluginRuntimePermission,
} from "../../shared/plugins";
import type {
  McpServerConfigInput,
  McpServerConfigRecord,
  NativeBridge,
  ProjectMcpServerConfigRecord,
  SystemPromptItemInput,
  SystemPromptItemRecord,
} from "../native/types";
import { isRecord } from "../utils/value";
import {
  hashImportPath,
  hashImportValue,
  normalizeLogicalId,
  type ImportCandidateInput,
} from "./discovery";
import { selectionForInput, type SelectedImportCandidate } from "./selectedImport";
import { prepareDirectoryCommit, type DirectoryCommit } from "./directoryCommit";
import { asStringArray, asStringRecord, collectSkillDirectories, nonEmptyString, walkFiles } from "./utils";

type PluginRuntimeComponent = {
  component: PluginComponentInput;
  mcpInput?: McpServerConfigInput;
  promptInput?: SystemPromptItemInput;
  skillSourceDir?: string;
};

export type PluginImportDefinition = {
  candidate: ImportCandidateInput;
  input: PluginInput;
  runtime: PluginRuntimeComponent[];
};

type PluginLocation = {
  scope: ImportScope;
  projectId?: string;
  projectRoot?: string;
};

const PLUGIN_MIGRATION_SETTING = "plugin-migration-v1";
const PLUGIN_MCP_SOURCE = "snow-plugin";
const PLUGIN_SKILL_ROOT = "plugins";
const DEFAULT_RUNTIME_TIMEOUT_MS = 30_000;
const MAX_RUNTIME_TIMEOUT_MS = 300_000;
const MARKETPLACE_FETCH_TIMEOUT_MS = 30_000;
const MARKETPLACE_MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const runtimePermissions = new Set<PluginRuntimePermission>([
  "storage",
  "network",
  "child-process",
]);

const safeSegment = (value: string): string =>
  value.trim().replace(/[\\/:*?"<>|]/g, "-").replace(/\.\.+/g, ".") || "plugin";

const isWithinDirectory = (path: string, root: string): boolean => {
  const relativePath = relative(resolve(root), resolve(path));
  return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath));
};

const readJson = (path: string, warnings: string[]): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(value) ? value : null;
  } catch (error) {
    warnings.push(`Unable to parse Plugin manifest ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
};

const pluginIdFor = (provider: ImportProvider, name: string, sourcePath: string): string =>
  `plugin:${provider}:${safeSegment(name)}:${hashImportValue({ provider, sourcePath: resolve(sourcePath) }).slice(0, 12)}`;

const pluginSkillPath = (
  pluginId: string,
  logicalId: string,
  scope: ImportScope,
  projectRoot?: string
): string => {
  const root = scope === "project" && projectRoot
    ? join(projectRoot, ".snow", "skills")
    : join(homedir(), ".snow", "skills");
  return join(root, PLUGIN_SKILL_ROOT, safeSegment(pluginId), logicalId);
};

const pluginSkillId = (pluginId: string, logicalId: string): string =>
  `${PLUGIN_SKILL_ROOT}/${safeSegment(pluginId)}/${logicalId}`;

const componentIdFor = (pluginId: string, type: string, logicalId: string): string =>
  `plugin-component:${hashImportValue({ pluginId, type, logicalId }).slice(0, 24)}`;

const pluginLocationForPath = (
  path: string,
  projects: Awaited<ReturnType<NativeBridge["listWorkspaceDirectories"]>>
): PluginLocation => {
  const project = projects
    .filter((item) => item.kind === "local")
    .sort((left, right) => right.path.length - left.path.length)
    .find((item) => path === item.path || path.startsWith(`${item.path}${sep}`));
  return project
    ? { scope: "project", projectId: project.directoryId, projectRoot: project.path }
    : { scope: "global" };
};

const addUnsupportedComponent = (
  components: PluginRuntimeComponent[],
  pluginId: string,
  type: PluginComponentInput["componentType"],
  logicalId: string,
  originPath: string,
  contentHash: string,
  reason: string
): void => {
  components.push({
    component: {
      componentId: componentIdFor(pluginId, type, logicalId),
      componentType: type,
      logicalId,
      targetId: "",
      targetPath: "",
      originPath,
      contentHash,
      status: "unsupported",
      unsupportedReason: reason,
      sortOrder: components.length,
    },
  });
};

const addMcpComponents = (
  components: PluginRuntimeComponent[],
  plugin: Pick<PluginInput, "pluginId" | "name" | "scope" | "projectId" | "state">,
  declarations: Record<string, unknown>,
  originPath: string
): void => {
  for (const [name, raw] of Object.entries(declarations)) {
    const logicalId = `mcp:${normalizeLogicalId(name)}`;
    const contentHash = hashImportValue(raw);
    if (!isRecord(raw)) {
      addUnsupportedComponent(components, plugin.pluginId, "mcp", logicalId, originPath, contentHash, "Plugin MCP declaration must be an object");
      continue;
    }
    const command = nonEmptyString(raw.command) ?? "";
    const url = nonEmptyString(raw.url) ?? "";
    if (!command && !url) {
      addUnsupportedComponent(components, plugin.pluginId, "mcp", logicalId, originPath, contentHash, "Plugin MCP declaration needs command or url");
      continue;
    }
    const targetId = `${plugin.pluginId}:mcp:${safeSegment(name)}`;
    const component: PluginComponentInput = {
      componentId: componentIdFor(plugin.pluginId, "mcp", logicalId),
      componentType: "mcp",
      logicalId,
      targetId,
      targetPath: "",
      originPath,
      contentHash,
      status: "supported",
      sortOrder: components.length,
    };
    components.push({
      component,
      mcpInput: {
        serverId: targetId,
        name: `${plugin.name}/${name}`,
        transportType: url ? "http" : "stdio",
        url,
        command,
        argsJson: JSON.stringify(asStringArray(raw.args)),
        envJson: JSON.stringify(asStringRecord(raw.env ?? raw.environment)),
        headersJson: JSON.stringify(asStringRecord(raw.headers ?? raw.http_headers)),
        enabled: plugin.state === "enabled",
        ...(typeof raw.timeout === "number" && raw.timeout > 0 ? { timeoutMs: Math.round(raw.timeout) } : {}),
        sortOrder: components.length,
        source: PLUGIN_MCP_SOURCE,
      },
    });
  }
};

const addSkillComponents = (
  components: PluginRuntimeComponent[],
  plugin: Pick<PluginInput, "pluginId" | "scope">,
  location: PluginLocation,
  root: string
): void => {
  for (const sourceDir of collectSkillDirectories(root)) {
    const logicalId = relative(root, sourceDir).split(sep).join("/");
    const targetPath = pluginSkillPath(plugin.pluginId, logicalId, plugin.scope, location.projectRoot);
    components.push({
      component: {
        componentId: componentIdFor(plugin.pluginId, "skill", logicalId),
        componentType: "skill",
        logicalId,
        targetId: pluginSkillId(plugin.pluginId, logicalId),
        targetPath,
        originPath: sourceDir,
        contentHash: hashImportPath(sourceDir),
        status: "supported",
        sortOrder: components.length,
      },
      skillSourceDir: sourceDir,
    });
  }
};

const addMarkdownComponents = (
  components: PluginRuntimeComponent[],
  plugin: Pick<PluginInput, "pluginId" | "name" | "scope" | "state">,
  type: "command" | "agent",
  root: string
): void => {
  for (const path of walkFiles(root, (file) => file.endsWith(".md"))) {
    let content = "";
    try {
      content = readFileSync(path, "utf8").trim();
    } catch {
      continue;
    }
    if (!content) continue;
    const logicalId = `${type}:${relative(root, path).split(sep).join("/")}`;
    const targetId = `${plugin.pluginId}:${type}:${safeSegment(logicalId)}`;
    components.push({
      component: {
        componentId: componentIdFor(plugin.pluginId, type, logicalId),
        componentType: type,
        logicalId,
        targetId,
        targetPath: "",
        originPath: path,
        contentHash: hashImportValue(content),
        status: "supported",
        sortOrder: components.length,
      },
      promptInput: {
        promptId: targetId,
        name: `${plugin.name} ${type} ${basename(path, ".md")}`,
        content,
        isActive: plugin.state === "enabled",
        sortOrder: components.length,
      },
    });
  }
};

const runtimeDeclarationFromManifest = (
  manifest: Record<string, unknown>,
  root: string,
  warnings: string[]
): PluginRuntimeDeclaration | undefined => {
  const snow = manifest.snow;
  if (!isRecord(snow) || snow.runtime === undefined) return undefined;
  if (!isRecord(snow.runtime)) {
    warnings.push(`Plugin runtime declaration in ${root} must be an object`);
    return undefined;
  }
  const entry = nonEmptyString(snow.runtime.entry);
  const declaredPermissions = snow.runtime.permissions;
  if (!entry || !Array.isArray(declaredPermissions) || !declaredPermissions.every((item) => typeof item === "string")) {
    warnings.push(`Plugin runtime declaration in ${root} requires an entry and permissions array`);
    return undefined;
  }
  const permissions = [...new Set(declaredPermissions)] as string[];
  if (permissions.length !== declaredPermissions.length ||
      permissions.some((permission) => !runtimePermissions.has(permission as PluginRuntimePermission))) {
    warnings.push(`Plugin runtime declaration in ${root} requests an unsupported permission`);
    return undefined;
  }
  const timeout = snow.runtime.timeoutMs;
  const timeoutMs = timeout === undefined ? DEFAULT_RUNTIME_TIMEOUT_MS :
    typeof timeout === "number" && Number.isInteger(timeout) && timeout >= 1_000 && timeout <= MAX_RUNTIME_TIMEOUT_MS
      ? timeout
      : null;
  if (timeoutMs === null) {
    warnings.push(`Plugin runtime declaration in ${root} has an invalid timeoutMs`);
    return undefined;
  }
  if (!/\.(?:cjs|mjs|js)$/i.test(entry)) {
    warnings.push(`Plugin runtime entry in ${root} must be a .js, .mjs, or .cjs file`);
    return undefined;
  }
  const resolvedRoot = resolve(root);
  const resolvedEntry = resolve(resolvedRoot, entry);
  const relativeEntry = relative(resolvedRoot, resolvedEntry);
  if (!relativeEntry || relativeEntry.startsWith(`..${sep}`) || relativeEntry === ".." || relativeEntry.includes("\0")) {
    warnings.push(`Plugin runtime entry in ${root} must stay within the Plugin directory`);
    return undefined;
  }
  if (!existsSync(resolvedEntry)) {
    warnings.push(`Plugin runtime entry does not exist: ${resolvedEntry}`);
    return undefined;
  }
  return {
    entry: relativeEntry,
    permissions: permissions as PluginRuntimePermission[],
    timeoutMs,
  };
};

const pluginDefinitionFromManifest = (
  provider: "codex" | "claude-code",
  manifestPath: string,
  location: PluginLocation,
  warnings: string[]
): PluginImportDefinition | null => {
  const manifest = readJson(manifestPath, warnings);
  if (!manifest) return null;
  const metadataRoot = dirname(manifestPath);
  const root = dirname(metadataRoot);
  const name = nonEmptyString(manifest.name) ?? basename(root);
  const pluginId = pluginIdFor(provider, name, root);
  const state = "enabled" as const;
  const base: Omit<PluginInput, "components" | "capabilities" | "contentHash"> = {
    pluginId,
    name,
    version: nonEmptyString(manifest.version) ?? "",
    provider,
    sourcePath: root,
    manifestPath,
    scope: location.scope,
    ...(location.projectId ? { projectId: location.projectId } : {}),
    state,
  };
  const components: PluginRuntimeComponent[] = [];
  addSkillComponents(components, base, location, join(root, "skills"));
  addMarkdownComponents(components, base, "command", join(root, "commands"));
  addMarkdownComponents(components, base, "agent", join(root, "agents"));

  const mcpPath = join(root, ".mcp.json");
  if (existsSync(mcpPath)) {
    const mcp = readJson(mcpPath, warnings);
    if (mcp) {
      const declared = isRecord(mcp.mcpServers) ? mcp.mcpServers : mcp;
      addMcpComponents(components, base, declared, mcpPath);
    }
  }
  const manifestMcp = manifest.mcpServers ?? manifest.mcp_servers;
  if (isRecord(manifestMcp)) {
    addMcpComponents(components, base, manifestMcp, manifestPath);
  }
  const hooksRoot = join(root, "hooks");
  if (existsSync(hooksRoot) || manifest.hooks !== undefined) {
    addUnsupportedComponent(
      components,
      pluginId,
      "hook",
      "hooks",
      existsSync(hooksRoot) ? hooksRoot : manifestPath,
      hashImportPath(existsSync(hooksRoot) ? hooksRoot : manifestPath),
      "Plugin hooks and executable code are not supported"
    );
  }
  const runtime = runtimeDeclarationFromManifest(manifest, root, warnings);
  const capabilities = [...new Set([
    ...components.map((item) => item.component.componentType),
    ...(runtime ? ["runtime"] : []),
  ])];
  const input: PluginInput = {
    ...base,
    capabilities,
    ...(runtime ? { runtime } : {}),
    contentHash: hashImportPath(root),
    components: components.map((item) => item.component),
  };
  return {
    candidate: {
      type: "plugin",
      provider,
      scope: input.scope,
      originPath: manifestPath,
      logicalId: input.pluginId,
      contentHash: input.contentHash,
      ...(input.projectId ? { projectId: input.projectId } : {}),
    },
    input,
    runtime: components,
  };
};

const findManifestPaths = (roots: string[], metadataDirectory: string): string[] =>
  roots.flatMap((root) => walkFiles(
    root,
    (path) => basename(path) === "plugin.json" && basename(dirname(path)) === metadataDirectory,
    10
  ));

const discoverManifestPlugins = async (native: NativeBridge): Promise<PluginImportDefinition[]> => {
  const projects = await native.listWorkspaceDirectories();
  const warnings: string[] = [];
  const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  const codexRoots = [
    join(codexHome, ".tmp", "marketplaces"),
    join(codexHome, "plugins"),
    join(homedir(), ".agents", "plugins"),
    join(homedir(), "plugins"),
    marketplacePluginStorageRoot(),
    ...projects.filter((item) => item.kind === "local").flatMap((item) => [
      join(item.path, ".agents", "plugins"),
      join(item.path, "plugins"),
    ]),
  ];
  const claudeHome = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
  const claudeRoots = [
    join(claudeHome, "plugins", "cache"),
    join(claudeHome, "plugins", "marketplaces"),
    join(claudeHome, "plugins"),
    marketplacePluginStorageRoot(),
    ...projects.filter((item) => item.kind === "local").map((item) => join(item.path, ".claude", "plugins")),
  ];
  const definitions = [
    ...findManifestPaths(codexRoots, ".codex-plugin").map((path) =>
      pluginDefinitionFromManifest("codex", path, pluginLocationForPath(path, projects), warnings)
    ),
    ...findManifestPaths(claudeRoots, ".claude-plugin").map((path) =>
      pluginDefinitionFromManifest("claude-code", path, pluginLocationForPath(path, projects), warnings)
    ),
  ].filter((item): item is PluginImportDefinition => Boolean(item));
  return definitions;
};

const discoverOpenCodePlugins = async (native: NativeBridge): Promise<PluginImportDefinition[]> => {
  const projects = await native.listWorkspaceDirectories();
  const configHome = process.env.OPENCODE_CONFIG_DIR?.trim()
    ? resolve(process.env.OPENCODE_CONFIG_DIR)
    : join(process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"), "opencode");
  const roots = [
    join(configHome, "plugins"),
    join(homedir(), ".opencode", "plugins"),
    ...projects.filter((item) => item.kind === "local").map((item) => join(item.path, ".opencode", "plugins")),
  ];
  const descriptors: PluginImportDefinition[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    for (const path of walkFiles(root, (file) => /\.(?:[cm]?js|ts)$/.test(file), 4)) {
      const sourcePath = resolve(path);
      if (seen.has(sourcePath)) continue;
      seen.add(sourcePath);
      const location = pluginLocationForPath(sourcePath, projects);
      const name = basename(path).replace(/\.(?:[cm]?js|ts)$/, "");
      const pluginId = pluginIdFor("opencode", name, sourcePath);
      const contentHash = hashImportPath(sourcePath);
      const component: PluginComponentInput = {
        componentId: componentIdFor(pluginId, "hook", "runtime"),
        componentType: "hook",
        logicalId: "runtime",
        targetId: "",
        targetPath: "",
        originPath: sourcePath,
        contentHash,
        status: "unsupported",
        unsupportedReason: "OpenCode Plugins are in-process JavaScript modules and are not executed by Snow App",
        sortOrder: 0,
      };
      const input: PluginInput = {
        pluginId,
        name,
        version: "",
        provider: "opencode",
        sourcePath,
        manifestPath: sourcePath,
        scope: location.scope,
        ...(location.projectId ? { projectId: location.projectId } : {}),
        state: "disabled",
        capabilities: ["hook"],
        contentHash,
        components: [component],
      };
      descriptors.push({
        candidate: {
          type: "plugin",
          provider: "opencode",
          scope: input.scope,
          originPath: sourcePath,
          logicalId: input.pluginId,
          contentHash,
          ...(input.projectId ? { projectId: input.projectId } : {}),
        },
        input,
        runtime: [{ component }],
      });
    }
  }
  return descriptors;
};

export const discoverPluginImports = async (native: NativeBridge): Promise<PluginImportDefinition[]> => {
  const [manifestPlugins, openCodePlugins] = await Promise.all([
    discoverManifestPlugins(native),
    discoverOpenCodePlugins(native),
  ]);
  const seen = new Set<string>();
  return [...manifestPlugins, ...openCodePlugins].filter((item) => {
    if (seen.has(item.input.pluginId)) return false;
    seen.add(item.input.pluginId);
    return true;
  });
};

export const selectedPluginImports = async (
  native: NativeBridge,
  selected: SelectedImportCandidate[]
): Promise<PluginImportDefinition[]> => {
  const definitions = await discoverPluginImports(native);
  return definitions.filter((definition) => Boolean(selectionForInput(definition.candidate, selected)));
};

type MarketplacePluginEntry = {
  name: string;
  displayName: string;
  description: string;
  version: string;
  category: string;
  tags: string[];
  source: unknown;
  defaultEnabled: boolean;
  unavailableReason?: string;
};

type MarketplaceManifest = {
  name: string;
  displayName: string;
  description: string;
  pluginRoot?: string;
  plugins: MarketplacePluginEntry[];
};

type MarketplaceSource = {
  type: PluginMarketplaceSourceType;
  path: string;
  refName?: string;
};

type MaterializedMarketplace = {
  source: MarketplaceSource;
  manifestPath: string;
  marketplaceRoot: string;
  cachePath?: string;
  contentHash: string;
  manifest: MarketplaceManifest;
};

type ResolvedMarketplacePluginSource =
  | { type: "local"; path: string }
  | { type: "git"; url: string; refName?: string; sha?: string; subdirectory?: string };

const marketplaceStorageRoot = (): string => join(homedir(), ".snow", "plugin-marketplaces");

const marketplacePluginStorageRoot = (): string => join(homedir(), ".snow", "plugins", "marketplaces");

const marketplaceCacheRoot = (name: string): string =>
  join(marketplaceStorageRoot(), safeSegment(name));

const marketplacePluginCacheRoot = (marketplaceName: string, pluginName: string): string =>
  join(marketplacePluginStorageRoot(), safeSegment(marketplaceName), safeSegment(pluginName));

const marketplaceIdFor = (name: string): string => `marketplace:${safeSegment(name)}`;

const runGit = async (args: string[], cwd?: string): Promise<void> => new Promise((resolvePromise, reject) => {
  execFile(
    "git",
    ["-c", "protocol.file.allow=never", "-c", "protocol.ext.allow=never", "-c", "core.hooksPath=/dev/null", ...args],
    { cwd, maxBuffer: MARKETPLACE_MAX_MANIFEST_BYTES, timeout: MARKETPLACE_FETCH_TIMEOUT_MS, windowsHide: true },
    (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(`Git operation failed: ${stderr.trim() || error.message}`));
        return;
      }
      resolvePromise();
    }
  );
});

const parseMarketplaceManifest = (path: string): MarketplaceManifest => {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Unable to parse marketplace manifest ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(raw)) throw new Error("Marketplace manifest must be a JSON object");
  const name = nonEmptyString(raw.name);
  if (!name) throw new Error("Marketplace manifest requires a name");
  if (!Array.isArray(raw.plugins)) throw new Error("Marketplace manifest requires a plugins array");
  const interfaceMetadata = isRecord(raw.interface) ? raw.interface : {};
  const metadata = isRecord(raw.metadata) ? raw.metadata : {};
  const plugins = raw.plugins.flatMap((item): MarketplacePluginEntry[] => {
    if (!isRecord(item)) return [];
    const pluginName = nonEmptyString(item.name);
    if (!pluginName || item.source === undefined) return [];
    const policy = isRecord(item.policy) ? item.policy : {};
    const installation = nonEmptyString(policy.installation);
    return [{
      name: pluginName,
      displayName: nonEmptyString(item.displayName) ?? pluginName,
      description: nonEmptyString(item.description) ?? "",
      version: nonEmptyString(item.version) ?? "",
      category: nonEmptyString(item.category) ?? "",
      tags: asStringArray(item.tags ?? item.keywords),
      source: item.source,
      defaultEnabled: item.defaultEnabled !== false,
      ...(installation === "NOT_AVAILABLE" ? { unavailableReason: "This Plugin is not available for installation." } : {}),
    }];
  });
  return {
    name,
    displayName: nonEmptyString(interfaceMetadata.displayName) ?? nonEmptyString(raw.displayName) ?? name,
    description: nonEmptyString(raw.description) ?? nonEmptyString(metadata.description) ?? "",
    ...(nonEmptyString(metadata.pluginRoot) ? { pluginRoot: nonEmptyString(metadata.pluginRoot) as string } : {}),
    plugins,
  };
};

const marketplaceRootForManifest = (manifestPath: string): string => {
  const manifestDirectory = dirname(manifestPath);
  const metadataDirectory = basename(manifestDirectory);
  if (metadataDirectory === "plugins" && basename(dirname(manifestDirectory)) === ".agents") {
    // Codex keeps marketplace metadata in `.agents/plugins`, but sources are repo-root relative.
    return dirname(dirname(manifestDirectory));
  }
  return metadataDirectory === ".claude-plugin" || metadataDirectory === ".codex-plugin"
    ? dirname(manifestDirectory)
    : manifestDirectory;
};

const findMarketplaceManifest = (path: string): string => {
  const resolved = resolve(path);
  const candidates = [
    resolved,
    join(resolved, ".claude-plugin", "marketplace.json"),
    join(resolved, ".codex-plugin", "marketplace.json"),
    join(resolved, ".agents", "plugins", "marketplace.json"),
    join(resolved, "marketplace.json"),
  ];
  const manifestPath = candidates.find((candidate) => existsSync(candidate) && basename(candidate) === "marketplace.json");
  if (!manifestPath) {
    throw new Error("Marketplace manifest not found. Expected marketplace.json, .agents/plugins/marketplace.json, or .claude-plugin/marketplace.json.");
  }
  return manifestPath;
};

const splitGitSource = (source: string): { url: string; refName?: string } => {
  const hash = source.lastIndexOf("#");
  if (hash <= 0) return { url: source };
  const url = source.slice(0, hash);
  const refName = source.slice(hash + 1).trim();
  return refName ? { url, refName } : { url };
};

const parseMarketplaceSource = (source: string): MarketplaceSource => {
  const input = source.trim();
  if (!input) throw new Error("Marketplace source is required");
  const localPath = resolve(input.startsWith("~/") ? join(homedir(), input.slice(2)) : input);
  if (existsSync(localPath) || input.startsWith(".") || input.startsWith("/") || input.startsWith("~")) {
    if (!existsSync(localPath)) throw new Error(`Marketplace path does not exist: ${input}`);
    return { type: "local", path: localPath };
  }
  const github = input.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:@([^\s/]+))?$/);
  if (github) {
    return {
      type: "github",
      path: `${github[1]}/${github[2]}`,
      ...(github[3] ? { refName: github[3] } : {}),
    };
  }
  if (input.startsWith("git@") || input.startsWith("ssh://")) {
    const { url, refName } = splitGitSource(input);
    return { type: "git", path: url, ...(refName ? { refName } : {}) };
  }
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("Marketplace source must be a local path, GitHub owner/repo, Git URL, or HTTPS marketplace.json URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Only HTTPS remote marketplace sources are supported");
  }
  if (parsed.pathname.endsWith(".git")) {
    const { url, refName } = splitGitSource(input);
    return { type: "git", path: url, ...(refName ? { refName } : {}) };
  }
  if (!parsed.pathname.endsWith(".json")) {
    throw new Error("Remote marketplace URLs must point directly to marketplace.json; use a .git URL for repositories");
  }
  return { type: "url", path: input };
};

const promoteDirectory = (stagedDirectory: string, targetDirectory: string): void => {
  mkdirSync(dirname(targetDirectory), { recursive: true });
  const backup = `${targetDirectory}.previous-${Date.now()}`;
  if (existsSync(targetDirectory)) renameSync(targetDirectory, backup);
  try {
    renameSync(stagedDirectory, targetDirectory);
  } catch (error) {
    if (existsSync(backup)) renameSync(backup, targetDirectory);
    throw error;
  }
  rmSync(backup, { recursive: true, force: true });
};

const promoteFile = (stagedFile: string, targetFile: string): void => {
  mkdirSync(dirname(targetFile), { recursive: true });
  const backup = `${targetFile}.previous-${Date.now()}`;
  if (existsSync(targetFile)) renameSync(targetFile, backup);
  try {
    renameSync(stagedFile, targetFile);
  } catch (error) {
    if (existsSync(backup)) renameSync(backup, targetFile);
    throw error;
  }
  rmSync(backup, { force: true });
};

const materializeGitMarketplace = async (source: MarketplaceSource): Promise<MaterializedMarketplace> => {
  mkdirSync(marketplaceStorageRoot(), { recursive: true });
  const stage = mkdtempSync(join(marketplaceStorageRoot(), ".marketplace-"));
  const repository = join(stage, "repository");
  try {
    const url = source.type === "github" ? `https://github.com/${source.path}.git` : source.path;
    const args = ["clone", "--depth", "1", "--no-tags"];
    if (source.refName) args.push("--branch", source.refName);
    args.push(url, repository);
    await runGit(args);
    const manifestPath = findMarketplaceManifest(repository);
    const manifest = parseMarketplaceManifest(manifestPath);
    const cacheRoot = marketplaceCacheRoot(manifest.name);
    const target = join(cacheRoot, "source");
    promoteDirectory(repository, target);
    const cachedManifestPath = join(target, relative(repository, manifestPath));
    return {
      source,
      manifestPath: cachedManifestPath,
      marketplaceRoot: marketplaceRootForManifest(cachedManifestPath),
      cachePath: cacheRoot,
      contentHash: hashImportPath(target),
      manifest,
    };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
};

const materializeUrlMarketplace = async (source: MarketplaceSource): Promise<MaterializedMarketplace> => {
  const response = await fetch(source.path, { signal: AbortSignal.timeout(MARKETPLACE_FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Marketplace request failed: ${response.status} ${response.statusText}`);
  const content = await response.text();
  if (content.length > MARKETPLACE_MAX_MANIFEST_BYTES) throw new Error("Marketplace manifest exceeds the 2 MB limit");
  mkdirSync(marketplaceStorageRoot(), { recursive: true });
  const stage = mkdtempSync(join(marketplaceStorageRoot(), ".marketplace-"));
  try {
    const stagedManifest = join(stage, "marketplace.json");
    writeFileSync(stagedManifest, content, "utf8");
    const manifest = parseMarketplaceManifest(stagedManifest);
    const cacheRoot = marketplaceCacheRoot(manifest.name);
    const target = join(cacheRoot, "marketplace.json");
    promoteFile(stagedManifest, target);
    return {
      source,
      manifestPath: target,
      marketplaceRoot: marketplaceRootForManifest(target),
      cachePath: cacheRoot,
      contentHash: hashImportPath(target),
      manifest,
    };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
};

const materializeMarketplace = async (source: MarketplaceSource): Promise<MaterializedMarketplace> => {
  if (source.type === "local") {
    const manifestPath = findMarketplaceManifest(source.path);
    return {
      source,
      manifestPath,
      marketplaceRoot: marketplaceRootForManifest(manifestPath),
      contentHash: hashImportPath(manifestPath),
      manifest: parseMarketplaceManifest(manifestPath),
    };
  }
  return source.type === "url" ? materializeUrlMarketplace(source) : materializeGitMarketplace(source);
};

const sourceFromMarketplaceRecord = (marketplace: PluginMarketplaceRecord): MarketplaceSource => ({
  type: marketplace.sourceType,
  path: marketplace.sourcePath,
  ...(marketplace.refName ? { refName: marketplace.refName } : {}),
});

const loadMarketplaceManifest = (marketplace: PluginMarketplaceRecord): { manifest: MarketplaceManifest; root: string } => {
  if (!existsSync(marketplace.manifestPath)) {
    throw new Error("Marketplace source is no longer available. Refresh it or remove it from Snow.");
  }
  return {
    manifest: parseMarketplaceManifest(marketplace.manifestPath),
    root: marketplaceRootForManifest(marketplace.manifestPath),
  };
};

const resolveMarketplacePluginSource = (
  entry: MarketplacePluginEntry,
  marketplace: MarketplaceManifest,
  marketplaceRoot: string
): ResolvedMarketplacePluginSource => {
  const resolveLocalSource = (path: string): ResolvedMarketplacePluginSource => {
    const base = marketplace.pluginRoot ? resolve(marketplaceRoot, marketplace.pluginRoot) : marketplaceRoot;
    const target = resolve(base, path);
    if (!isWithinDirectory(target, marketplaceRoot)) {
      throw new Error("Marketplace Plugin source must stay within the marketplace directory");
    }
    if (!existsSync(target)) throw new Error(`Plugin source does not exist: ${path}`);
    return { type: "local", path: target };
  };
  if (typeof entry.source === "string") {
    if (!entry.source.startsWith(".")) throw new Error("String Plugin sources must be relative paths");
    return resolveLocalSource(entry.source);
  }
  if (!isRecord(entry.source)) throw new Error("Plugin source must be a path or supported source descriptor");
  const sourceType = nonEmptyString(entry.source.source);
  if (sourceType === "local") {
    const path = nonEmptyString(entry.source.path);
    if (!path) throw new Error("Local Plugin sources require a path");
    return resolveLocalSource(path);
  }
  const refName = nonEmptyString(entry.source.ref);
  const sha = nonEmptyString(entry.source.sha);
  if (sourceType === "github") {
    const repository = nonEmptyString(entry.source.repo);
    if (!repository) throw new Error("GitHub Plugin sources require a repository");
    return { type: "git", url: `https://github.com/${repository}.git`, ...(refName ? { refName } : {}), ...(sha ? { sha } : {}) };
  }
  if (sourceType === "url") {
    const url = nonEmptyString(entry.source.url);
    if (!url) throw new Error("Git Plugin sources require a URL");
    return { type: "git", url, ...(refName ? { refName } : {}), ...(sha ? { sha } : {}) };
  }
  if (sourceType === "git-subdir") {
    const url = nonEmptyString(entry.source.url);
    const path = nonEmptyString(entry.source.path);
    if (!url || !path) throw new Error("git-subdir Plugin sources require a URL and path");
    return { type: "git", url, ...(refName ? { refName } : {}), ...(sha ? { sha } : {}), subdirectory: path };
  }
  throw new Error(`Plugin source type ${sourceType ?? "unknown"} is not supported`);
};

const marketplaceEntryCatalog = (
  entry: MarketplacePluginEntry,
  marketplace: PluginMarketplaceRecord,
  manifest: MarketplaceManifest,
  root: string,
  installedPlugins: PluginRecord[]
): PluginMarketplacePlugin => {
  const installedPluginId = installedPlugins.find((plugin) =>
    resolve(plugin.sourcePath) === resolve(marketplacePluginCacheRoot(marketplace.name, entry.name))
  )?.pluginId;
  try {
    if (entry.unavailableReason) throw new Error(entry.unavailableReason);
    resolveMarketplacePluginSource(entry, manifest, root);
    return {
      pluginName: entry.name,
      displayName: entry.displayName,
      description: entry.description,
      version: entry.version,
      category: entry.category,
      tags: entry.tags,
      supported: true,
      ...(installedPluginId ? { installedPluginId } : {}),
    };
  } catch (error) {
    return {
      pluginName: entry.name,
      displayName: entry.displayName,
      description: entry.description,
      version: entry.version,
      category: entry.category,
      tags: entry.tags,
      supported: false,
      unsupportedReason: error instanceof Error ? error.message : String(error),
      ...(installedPluginId ? { installedPluginId } : {}),
    };
  }
};

export const listPluginMarketplaces = async (native: NativeBridge): Promise<PluginMarketplaceCatalog[]> => {
  const [marketplaces, plugins] = await Promise.all([native.listPluginMarketplaces(), native.listPlugins()]);
  return marketplaces.map((marketplace) => {
    try {
      const { manifest, root } = loadMarketplaceManifest(marketplace);
      return {
        ...marketplace,
        displayName: manifest.displayName,
        description: manifest.description,
        plugins: manifest.plugins.map((entry) => marketplaceEntryCatalog(entry, marketplace, manifest, root, plugins)),
      };
    } catch (error) {
      return {
        ...marketplace,
        plugins: [],
        loadError: error instanceof Error ? error.message : String(error),
      };
    }
  });
};

export const addPluginMarketplace = async (
  native: NativeBridge,
  sourceInput: string
): Promise<PluginMarketplaceCatalog[]> => {
  const materialized = await materializeMarketplace(parseMarketplaceSource(sourceInput));
  await native.upsertPluginMarketplace({
    marketplaceId: marketplaceIdFor(materialized.manifest.name),
    name: materialized.manifest.name,
    displayName: materialized.manifest.displayName,
    description: materialized.manifest.description,
    sourceType: materialized.source.type,
    sourcePath: materialized.source.path,
    ...(materialized.source.refName ? { refName: materialized.source.refName } : {}),
    ...(materialized.cachePath ? { cachePath: materialized.cachePath } : {}),
    manifestPath: materialized.manifestPath,
    contentHash: materialized.contentHash,
  });
  return listPluginMarketplaces(native);
};

export const updatePluginMarketplace = async (
  native: NativeBridge,
  marketplaceId: string
): Promise<PluginMarketplaceCatalog[]> => {
  const marketplace = (await native.listPluginMarketplaces()).find((item) => item.marketplaceId === marketplaceId);
  if (!marketplace) throw new Error("Plugin marketplace not found");
  const materialized = await materializeMarketplace(sourceFromMarketplaceRecord(marketplace));
  if (materialized.manifest.name !== marketplace.name) {
    throw new Error("Marketplace name changed. Remove the old marketplace before adding this source again.");
  }
  await native.upsertPluginMarketplace({
    marketplaceId: marketplace.marketplaceId,
    name: marketplace.name,
    displayName: materialized.manifest.displayName,
    description: materialized.manifest.description,
    sourceType: materialized.source.type,
    sourcePath: materialized.source.path,
    ...(materialized.source.refName ? { refName: materialized.source.refName } : {}),
    ...(materialized.cachePath ? { cachePath: materialized.cachePath } : {}),
    manifestPath: materialized.manifestPath,
    contentHash: materialized.contentHash,
  });
  return listPluginMarketplaces(native);
};

export const removePluginMarketplace = async (native: NativeBridge, marketplaceId: string): Promise<void> => {
  const marketplace = (await native.listPluginMarketplaces()).find((item) => item.marketplaceId === marketplaceId);
  if (!marketplace) throw new Error("Plugin marketplace not found");
  await native.deletePluginMarketplace(marketplaceId);
  if (marketplace.cachePath && isWithinDirectory(marketplace.cachePath, marketplaceStorageRoot())) {
    rmSync(marketplace.cachePath, { recursive: true, force: true });
  }
};

const cloneMarketplacePlugin = async (
  source: Extract<ResolvedMarketplacePluginSource, { type: "git" }>
): Promise<{ sourcePath: string; cleanupPath: string }> => {
  const stage = mkdtempSync(join(tmpdir(), "snow-marketplace-plugin-"));
  const repository = join(stage, "repository");
  try {
    const args = ["clone", "--depth", "1", "--no-tags"];
    if (source.refName) args.push("--branch", source.refName);
    args.push(source.url, repository);
    await runGit(args);
    if (source.sha) {
      await runGit(["fetch", "--depth", "1", "origin", source.sha], repository);
      await runGit(["checkout", "--detach", source.sha], repository);
    }
    const sourcePath = source.subdirectory ? resolve(repository, source.subdirectory) : repository;
    if (!isWithinDirectory(sourcePath, repository) || !existsSync(sourcePath)) {
      throw new Error("Plugin source subdirectory does not exist in the cloned repository");
    }
    return { sourcePath, cleanupPath: stage };
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
};

const copyMarketplacePlugin = (sourcePath: string, marketplaceName: string, pluginName: string): string => {
  const target = marketplacePluginCacheRoot(marketplaceName, pluginName);
  mkdirSync(dirname(target), { recursive: true });
  const stage = mkdtempSync(join(dirname(target), ".plugin-"));
  const stagedPlugin = join(stage, "plugin");
  try {
    cpSync(sourcePath, stagedPlugin, { recursive: true, force: true });
    promoteDirectory(stagedPlugin, target);
    return target;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
};

const findPluginManifest = (root: string): { provider: "codex" | "claude-code"; manifestPath: string } => {
  const codexManifest = join(root, ".codex-plugin", "plugin.json");
  if (existsSync(codexManifest)) return { provider: "codex", manifestPath: codexManifest };
  const claudeManifest = join(root, ".claude-plugin", "plugin.json");
  if (existsSync(claudeManifest)) return { provider: "claude-code", manifestPath: claudeManifest };
  throw new Error("Plugin package must contain .codex-plugin/plugin.json or .claude-plugin/plugin.json");
};

export const installPluginFromMarketplace = async (
  native: NativeBridge,
  marketplaceId: string,
  pluginName: string
): Promise<void> => {
  const marketplace = (await native.listPluginMarketplaces()).find((item) => item.marketplaceId === marketplaceId);
  if (!marketplace) throw new Error("Plugin marketplace not found");
  const { manifest, root } = loadMarketplaceManifest(marketplace);
  const entry = manifest.plugins.find((item) => item.name === pluginName);
  if (!entry) throw new Error("Plugin is not available in this marketplace");
  if (entry.unavailableReason) throw new Error(entry.unavailableReason);
  const source = resolveMarketplacePluginSource(entry, manifest, root);
  const remoteSource = source.type === "git" ? await cloneMarketplacePlugin(source) : null;
  try {
    const sourcePath = source.type === "local" ? source.path : remoteSource?.sourcePath;
    if (!sourcePath) throw new Error("Unable to resolve Plugin source");
    const cachedPluginRoot = copyMarketplacePlugin(sourcePath, marketplace.name, entry.name);
    const { provider, manifestPath } = findPluginManifest(cachedPluginRoot);
    const warnings: string[] = [];
    const definition = pluginDefinitionFromManifest(provider, manifestPath, { scope: "global" }, warnings);
    if (!definition) throw new Error(warnings[0] ?? "Unable to parse Plugin manifest");
    const existing = (await native.listPlugins()).find((plugin) => plugin.pluginId === definition.input.pluginId);
    definition.input.state = existing?.state === "disabled" || (!existing && !entry.defaultEnabled) ? "disabled" : "enabled";
    for (const runtime of definition.runtime) {
      if (runtime.mcpInput) runtime.mcpInput.enabled = definition.input.state === "enabled";
      if (runtime.promptInput) runtime.promptInput.isActive = definition.input.state === "enabled";
    }
    const result = await commitPluginImports(native, [definition]);
    if (result.itemResults.some((item) => item.status === "skipped")) {
      throw new Error(result.warnings[0] ?? "Plugin installation failed");
    }
  } finally {
    if (remoteSource) rmSync(remoteSource.cleanupPath, { recursive: true, force: true });
  }
};

const pluginResourceFor = (
  plugin: PluginInput,
  component: PluginComponentInput
): ImportResourceInput | null => {
  if (component.status !== "supported" || component.componentType === "hook") return null;
  return {
    resourceId: `plugin:${plugin.pluginId}:${component.componentId}`,
    resourceType: component.componentType,
    scope: plugin.scope,
    ...(plugin.projectId ? { projectId: plugin.projectId } : {}),
    targetId: component.targetId,
    targetPath: component.targetPath,
    management: "snapshot",
    sources: [{
      provider: plugin.provider,
      scope: plugin.scope,
      originPath: component.originPath,
      ...(plugin.projectId ? { projectId: plugin.projectId } : {}),
      contentHash: component.contentHash,
    }],
  };
};

const mcpRecordToInput = (record: McpServerConfigRecord | ProjectMcpServerConfigRecord, enabled: boolean): McpServerConfigInput => ({
  serverId: record.serverId,
  name: record.name,
  transportType: record.transportType,
  url: record.url,
  command: record.command,
  argsJson: record.argsJson,
  envJson: record.envJson,
  headersJson: record.headersJson,
  enabled,
  ...(record.timeoutMs === null ? {} : { timeoutMs: record.timeoutMs }),
  sortOrder: record.sortOrder,
  source: record.source,
});

const promptRecordToInput = (record: SystemPromptItemRecord, isActive: boolean): SystemPromptItemInput => ({
  promptId: record.promptId,
  name: record.name,
  content: record.content,
  isActive,
  sortOrder: record.sortOrder,
});

const copyPluginSkill = (source: string, target: string): DirectoryCommit => {
  if (!existsSync(source)) {
    throw new Error(`Plugin Skill source no longer exists: ${source}`);
  }
  const transaction = prepareDirectoryCommit(source, target);
  transaction.commit();
  return transaction;
};

export const commitPluginImports = async (
  native: NativeBridge,
  definitions: PluginImportDefinition[]
): Promise<{ itemResults: ImportCommitItemResult[]; warnings: string[] }> => {
  const itemResults: ImportCommitItemResult[] = [];
  const warnings: string[] = [];
  for (const definition of definitions) {
    const appliedMcp: Array<{ projectId?: string; previous?: McpServerConfigRecord | ProjectMcpServerConfigRecord; input: McpServerConfigInput }> = [];
    const appliedPrompts: Array<{ previous?: SystemPromptItemRecord; input: SystemPromptItemInput }> = [];
    const copiedSkills: DirectoryCommit[] = [];
    try {
      const globalMcp = await native.listMcpServerConfigs();
      const projectMcp = definition.input.scope === "project" && definition.input.projectId
        ? await native.listProjectMcpServerConfigs(definition.input.projectId)
        : [];
      const prompts = await native.listSystemPrompts();
      for (const runtime of definition.runtime) {
        if (runtime.component.status !== "supported") continue;
        if (runtime.mcpInput) {
          const previous = definition.input.scope === "project"
            ? projectMcp.find((item) => item.serverId === runtime.mcpInput?.serverId)
            : globalMcp.find((item) => item.serverId === runtime.mcpInput?.serverId);
          if (definition.input.scope === "project" && definition.input.projectId) {
            await native.upsertProjectMcpServerConfig(definition.input.projectId, runtime.mcpInput);
          } else {
            await native.upsertMcpServerConfig(runtime.mcpInput);
          }
          appliedMcp.push({ projectId: definition.input.projectId, previous, input: runtime.mcpInput });
        } else if (runtime.promptInput) {
          const previous = prompts.find((item) => item.promptId === runtime.promptInput?.promptId);
          await native.upsertSystemPrompt(runtime.promptInput);
          appliedPrompts.push({ previous, input: runtime.promptInput });
        } else if (runtime.skillSourceDir) {
          copiedSkills.push(copyPluginSkill(runtime.skillSourceDir, runtime.component.targetPath));
          await native.setSkillEnabled(definition.input.projectId, runtime.component.targetId, definition.input.state === "enabled");
        }
      }
      await native.upsertPlugins([definition.input]);
      const resources = definition.input.components
        .map((component) => pluginResourceFor(definition.input, component))
        .filter((item): item is ImportResourceInput => Boolean(item));
      if (resources.length > 0) await native.upsertImportResources(resources);
      itemResults.push({
        candidateId: definition.input.pluginId,
        type: "plugin",
        logicalId: definition.input.pluginId,
        status: "imported",
      });
    } catch (error) {
      for (const applied of [...appliedMcp].reverse()) {
        if (applied.projectId) {
          if (applied.previous) await native.upsertProjectMcpServerConfig(applied.projectId, mcpRecordToInput(applied.previous, applied.previous.enabled));
          else await native.deleteProjectMcpServerConfig(applied.projectId, applied.input.serverId);
        } else if (applied.previous) {
          await native.upsertMcpServerConfig(mcpRecordToInput(applied.previous, applied.previous.enabled));
        } else {
          await native.deleteMcpServerConfig(applied.input.serverId);
        }
      }
      for (const applied of [...appliedPrompts].reverse()) {
        if (applied.previous) await native.upsertSystemPrompt(promptRecordToInput(applied.previous, applied.previous.isActive));
        else await native.deleteSystemPrompt(applied.input.promptId);
      }
      for (const skill of copiedSkills.reverse()) {
        try {
          skill.rollback();
        } catch (rollbackError) {
          warnings.push(
            `Plugin Skill rollback was incomplete: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
          );
        }
      }
      warnings.push(`Unable to import Plugin ${definition.input.name}: ${error instanceof Error ? error.message : String(error)}`);
      itemResults.push({ type: "plugin", logicalId: definition.input.pluginId, candidateId: definition.input.pluginId, status: "skipped", message: warnings.at(-1) });
    } finally {
      for (const skill of copiedSkills) {
        skill.cleanup();
      }
    }
  }
  return { itemResults, warnings };
};

const pluginById = async (native: NativeBridge, pluginId: string): Promise<PluginRecord> => {
  const plugin = (await native.listPlugins()).find((item) => item.pluginId === pluginId);
  if (!plugin) throw new Error("Plugin not found");
  return plugin;
};

export const setManagedPluginEnabled = async (
  native: NativeBridge,
  pluginId: string,
  enabled: boolean
): Promise<void> => {
  const plugin = await pluginById(native, pluginId);
  if (enabled && !plugin.components.some((component) => component.status === "supported")) {
    throw new Error("This Plugin has no declarative components Snow App can enable");
  }
  const globalMcp = await native.listMcpServerConfigs();
  const projectMcp = plugin.scope === "project" && plugin.projectId
    ? await native.listProjectMcpServerConfigs(plugin.projectId)
    : [];
  const prompts = await native.listSystemPrompts();
  const skills = await native.listAvailableSkills(plugin.projectId);
  const actions: Array<() => Promise<void>> = [];
  const rollback: Array<() => Promise<void>> = [];
  for (const component of plugin.components.filter((item) => item.status === "supported")) {
    if (component.componentType === "mcp") {
      const current = plugin.scope === "project"
        ? projectMcp.find((item) => item.serverId === component.targetId)
        : globalMcp.find((item) => item.serverId === component.targetId);
      if (!current) throw new Error(`Plugin MCP component is missing: ${component.logicalId}`);
      if (plugin.scope === "project" && plugin.projectId) {
        actions.push(() => native.upsertProjectMcpServerConfig(plugin.projectId as string, mcpRecordToInput(current, enabled)));
        rollback.push(() => native.upsertProjectMcpServerConfig(plugin.projectId as string, mcpRecordToInput(current, current.enabled)));
      } else {
        actions.push(() => native.upsertMcpServerConfig(mcpRecordToInput(current, enabled)));
        rollback.push(() => native.upsertMcpServerConfig(mcpRecordToInput(current, current.enabled)));
      }
    } else if (component.componentType === "skill") {
      const current = skills.find((item) => item.id === component.targetId);
      if (!current) throw new Error(`Plugin Skill component is missing: ${component.logicalId}`);
      actions.push(() => native.setSkillEnabled(plugin.projectId, component.targetId, enabled));
      rollback.push(() => native.setSkillEnabled(plugin.projectId, component.targetId, current.enabled));
    } else {
      const current = prompts.find((item) => item.promptId === component.targetId);
      if (!current) throw new Error(`Plugin prompt component is missing: ${component.logicalId}`);
      actions.push(() => native.upsertSystemPrompt(promptRecordToInput(current, enabled)));
      rollback.push(() => native.upsertSystemPrompt(promptRecordToInput(current, current.isActive)));
    }
  }
  try {
    for (const action of actions) await action();
    await native.setPluginState(pluginId, enabled ? "enabled" : "disabled");
  } catch (error) {
    for (const action of rollback.reverse()) await action();
    throw error;
  }
};

export const removeManagedPlugin = async (native: NativeBridge, pluginId: string): Promise<void> => {
  const plugin = await pluginById(native, pluginId);
  const [globalMcp, projectMcp, prompts] = await Promise.all([
    native.listMcpServerConfigs(),
    plugin.scope === "project" && plugin.projectId
      ? native.listProjectMcpServerConfigs(plugin.projectId)
      : Promise.resolve([]),
    native.listSystemPrompts(),
  ]);
  for (const component of plugin.components.filter((item) => item.status === "supported")) {
    if (component.componentType === "mcp") {
      if (plugin.scope === "project" && plugin.projectId) {
        if (projectMcp.some((item) => item.serverId === component.targetId)) {
          await native.deleteProjectMcpServerConfig(plugin.projectId, component.targetId);
        }
      } else if (globalMcp.some((item) => item.serverId === component.targetId)) {
        await native.deleteMcpServerConfig(component.targetId);
      }
    } else if (component.componentType === "skill") {
      const managedSegment = `${sep}.snow${sep}skills${sep}${PLUGIN_SKILL_ROOT}${sep}${safeSegment(plugin.pluginId)}${sep}`;
      if (component.targetPath.includes(managedSegment)) {
        rmSync(component.targetPath, { recursive: true, force: true });
      }
    } else if (prompts.some((item) => item.promptId === component.targetId)) {
      await native.deleteSystemPrompt(component.targetId);
    }
  }
  const resources = await native.listImportResources();
  for (const resource of resources.filter((item) => item.resourceId.startsWith(`plugin:${pluginId}:`))) {
    for (const source of resource.sources) {
      await native.releaseImportResource({ resourceId: resource.resourceId, sourceId: source.sourceId, disposition: "delete" });
    }
  }
  await native.deletePlugin(pluginId);
};

export const refreshManagedPlugins = async (native: NativeBridge): Promise<PluginRecord[]> => {
  const [managed, discovered] = await Promise.all([native.listPlugins(), discoverPluginImports(native)]);
  const byId = new Map(discovered.map((item) => [item.input.pluginId, item.input]));
  await Promise.all(managed.map(async (plugin) => {
    if (plugin.pluginId.startsWith("legacy:")) return;
    const current = byId.get(plugin.pluginId);
    if (!current) return native.setPluginState(plugin.pluginId, "broken");
    if (current.contentHash !== plugin.contentHash) return native.setPluginState(plugin.pluginId, "update-available");
  }));
  return native.listPlugins();
};

export const updateManagedPlugin = async (native: NativeBridge, pluginId: string): Promise<void> => {
  const definition = (await discoverPluginImports(native)).find((item) => item.input.pluginId === pluginId);
  if (!definition) throw new Error("Plugin source is no longer available");
  const existing = await pluginById(native, pluginId);
  definition.input.state = existing.state === "disabled" ? "disabled" : "enabled";
  for (const runtime of definition.runtime) {
    if (runtime.mcpInput) runtime.mcpInput.enabled = definition.input.state === "enabled";
    if (runtime.promptInput) runtime.promptInput.isActive = definition.input.state === "enabled";
  }
  const result = await commitPluginImports(native, [definition]);
  if (result.itemResults.some((item) => item.status === "skipped")) throw new Error(result.warnings[0] ?? "Plugin update failed");
};

export const ensureLegacyCodexPluginMigration = async (native: NativeBridge): Promise<void> => {
  if (await native.getSystemSettingValue(PLUGIN_MIGRATION_SETTING)) return;
  const path = join(homedir(), ".snow", "codex-plugins.json");
  const warnings: string[] = [];
  const raw = existsSync(path) ? readJson(path, warnings) : null;
  const entries = raw && Array.isArray(raw.plugins)
    ? raw.plugins.filter(isRecord)
    : raw && Array.isArray(raw.items)
      ? raw.items.filter(isRecord)
      : [];
  const sourcePaths = new Map<string, string>();
  for (const entry of entries) {
    const sourcePath = nonEmptyString(entry.path) ?? nonEmptyString(entry.root) ?? nonEmptyString(entry.manifestPath);
    if (!sourcePath) continue;
    const key = nonEmptyString(entry.id) ?? nonEmptyString(entry.name) ?? basename(sourcePath);
    sourcePaths.set(key, sourcePath);
  }
  const keyForLegacyResource = (value: string): string | null => {
    if (!value.startsWith("codex-plugin:")) return null;
    const payload = value.slice("codex-plugin:".length);
    const promptMarker = payload.indexOf(":prompt:");
    if (promptMarker >= 0) return payload.slice(0, promptMarker);
    const separator = payload.lastIndexOf(":");
    return separator >= 0 ? payload.slice(0, separator) : payload;
  };
  const componentGroups = new Map<string, PluginComponentInput[]>();
  const addComponent = (key: string, component: Omit<PluginComponentInput, "componentId" | "sortOrder">): void => {
    const components = componentGroups.get(key) ?? [];
    components.push({
      ...component,
      componentId: componentIdFor(`legacy:codex:${key}`, component.componentType, component.logicalId),
      sortOrder: components.length,
    });
    componentGroups.set(key, components);
  };
  const [mcpServers, prompts, skills] = await Promise.all([
    native.listMcpServerConfigs(),
    native.listSystemPrompts(),
    native.listAvailableSkills(),
  ]);
  for (const server of mcpServers) {
    const key = keyForLegacyResource(server.serverId);
    if (!key || (server.source !== "codex-plugin" && !server.serverId.startsWith("codex-plugin:"))) continue;
    addComponent(key, {
      componentType: "mcp",
      logicalId: `mcp:${server.name}`,
      targetId: server.serverId,
      targetPath: "",
      originPath: path,
      contentHash: hashImportValue(server),
      status: "supported",
    });
  }
  for (const prompt of prompts) {
    const key = keyForLegacyResource(prompt.promptId);
    if (!key) continue;
    addComponent(key, {
      componentType: "prompt",
      logicalId: `prompt:${prompt.promptId}`,
      targetId: prompt.promptId,
      targetPath: "",
      originPath: path,
      contentHash: hashImportValue(prompt.content),
      status: "supported",
    });
  }
  const legacySkillRoot = join(homedir(), ".snow", "skills", "codex-plugins");
  for (const skill of skills) {
    const resolvedPath = resolve(skill.path);
    if (!resolvedPath.startsWith(`${resolve(legacySkillRoot)}${sep}`)) continue;
    const [key] = relative(legacySkillRoot, resolvedPath).split(sep);
    if (!key) continue;
    addComponent(key, {
      componentType: "skill",
      logicalId: `skill:${skill.id}`,
      targetId: skill.id,
      targetPath: skill.path,
      originPath: skill.path,
      contentHash: hashImportPath(skill.path),
      status: "supported",
    });
  }
  const keys = new Set([...sourcePaths.keys(), ...componentGroups.keys()]);
  const records: PluginInput[] = [...keys].map((key) => {
    const components = componentGroups.get(key) ?? [];
    const sourcePath = sourcePaths.get(key) ?? path;
    const active = components.some((component) => {
      if (component.componentType === "mcp") return mcpServers.some((item) => item.serverId === component.targetId && item.enabled);
      if (component.componentType === "skill") return skills.some((item) => item.id === component.targetId && item.enabled);
      return prompts.some((item) => item.promptId === component.targetId && item.isActive);
    });
    return {
      pluginId: `legacy:codex:${safeSegment(key)}`,
      name: key,
      version: "",
      provider: "codex",
      sourcePath,
      manifestPath: path,
      scope: "global",
      state: active ? "enabled" : "disabled",
      capabilities: [...new Set(components.map((component) => component.componentType))],
      contentHash: hashImportValue(components.map((component) => ({
        logicalId: component.logicalId,
        contentHash: component.contentHash,
      }))),
      components,
    };
  });
  if (records.length > 0) await native.upsertPlugins(records);
  await native.setSystemSetting("Plugin migration version", PLUGIN_MIGRATION_SETTING, "1");
};
