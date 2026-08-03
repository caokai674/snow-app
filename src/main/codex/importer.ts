import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseToml } from "@iarna/toml";
import type {
  McpServerConfigInput,
  NativeBridge,
  SystemPromptItemInput,
  WorkspaceDirectoryRecord,
} from "../native/types";
import { SNOW_CLI_CONFIG_DIR } from "../snowCli/paths";
import { isRecord, toBoolean } from "../utils/value";
import { getCodexConfigPath, getCodexHome } from "./paths";
import type { CodexImportPreview, CodexImportResult } from "./types";

const CODEX_MCP_SOURCE = "codex";
const CODEX_PLUGIN_MCP_SOURCE = "codex-plugin";
const CODEX_PLUGIN_REGISTRY_FILE = join(SNOW_CLI_CONFIG_DIR, "codex-plugins.json");
const SKILL_FILE_NAME = "SKILL.md";
const MAX_SCAN_DEPTH = 10;

type ImportScope = "global" | "project";

type ConfigSource = {
  scope: ImportScope;
  configPath: string;
  projectId?: string;
  projectRoot?: string;
  values: Record<string, unknown>;
};

type ImportedMcp = {
  scope: ImportScope;
  projectId?: string;
  input: McpServerConfigInput;
};

type ImportedPrompt = SystemPromptItemInput;

type PluginDescriptor = {
  manifestKind: "codex" | "claude" | "cursor";
  id: string;
  name: string;
  root: string;
  manifestPath: string;
  scope: ImportScope;
  projectId?: string;
  projectRoot?: string;
  enabled: boolean;
  manifest: Record<string, unknown>;
  skillRoots: string[];
  mcpServers: Record<string, unknown>;
  defaultPrompts: string[];
};

type SkillCopy = {
  sourceDir: string;
  destinationDir: string;
};

type CodexImportContext = {
  preview: CodexImportPreview;
  globalCodexMcpSourceFound: boolean;
  globalPluginMcpSourceFound: boolean;
  projectCodexMcpSourceIds: Set<string>;
  projectPluginMcpSourceIds: Set<string>;
  codexPromptSourceFound: boolean;
  pluginPromptSourceFound: boolean;
  mcpServers: ImportedMcp[];
  prompts: ImportedPrompt[];
  skills: SkillCopy[];
  plugins: PluginDescriptor[];
};

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

const asStringRecord = (value: unknown): Record<string, string> => {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(
      ([key, item]) => key.trim().length > 0 && typeof item === "string"
    )
  ) as Record<string, string>;
};

const asPathList = (value: unknown): string[] => {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item === "string") {
        return [item];
      }
      if (isRecord(item) && typeof item.path === "string") {
        return [item.path];
      }
      return [];
    });
  }
  if (isRecord(value) && typeof value.path === "string") {
    return [value.path];
  }
  return [];
};

const nonEmptyString = (value: unknown): string | null => {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text : null;
};

const safeSegment = (value: string): string =>
  value
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\.\.+/g, ".") || "codex-plugin";

const readToml = (
  filePath: string,
  warnings: string[]
): Record<string, unknown> | null => {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const parsed = parseToml(readFileSync(filePath, "utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    warnings.push(`Unable to parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
};

const readJson = (
  filePath: string,
  warnings: string[]
): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch (error) {
    warnings.push(`Unable to parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
};

const walkFiles = (root: string, predicate: (filePath: string) => boolean): string[] => {
  if (!existsSync(root)) {
    return [];
  }

  const matches: string[] = [];
  const visit = (current: string, depth: number): void => {
    if (depth > MAX_SCAN_DEPTH) {
      return;
    }
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "sessions") {
        continue;
      }
      const entryPath = join(current, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath, depth + 1);
      } else if (entry.isFile() && predicate(entryPath)) {
        matches.push(entryPath);
      }
    }
  };

  visit(root, 0);
  return matches;
};

const collectSkillDirectories = (root: string): string[] => {
  const files = walkFiles(root, (filePath) => filePath.endsWith(`${sep}${SKILL_FILE_NAME}`));
  return files.map(dirname).filter((skillDir) => relative(root, skillDir) !== "");
};

const resolveDeclaredPath = (root: string, declaredPath: string): string => {
  const trimmed = declaredPath.trim();
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(root, trimmed.replace(/^\.\//, ""));
};

const resolvePluginDeclaredPath = (
  root: string,
  declaredPath: string,
  warnings: string[],
  resourceName: string
): string | null => {
  const trimmed = declaredPath.trim();
  if (!trimmed.startsWith("./") || isAbsolute(trimmed)) {
    warnings.push("Ignoring " + resourceName + " path outside plugin root: " + declaredPath);
    return null;
  }
  const candidate = resolve(root, trimmed.slice(2));
  const resolvedRoot = resolve(root);
  const rootWithSeparator = resolvedRoot + sep;
  if (candidate !== resolvedRoot && !candidate.startsWith(rootWithSeparator)) {
    warnings.push("Ignoring " + resourceName + " path outside plugin root: " + declaredPath);
    return null;
  }
  return candidate;
};

const pluginManifestFile = (filePath: string): boolean => {
  const parent = dirname(filePath).split(sep).pop();
  return parent === ".codex-plugin" || parent === ".claude-plugin" || parent === ".cursor-plugin";
};

const pluginManifestKind = (manifestPath: string): PluginDescriptor["manifestKind"] => {
  const parent = dirname(manifestPath).split(sep).pop();
  return parent === ".claude-plugin" ? "claude" : parent === ".cursor-plugin" ? "cursor" : "codex";
};

const pluginRootFromManifest = (manifestPath: string): string => {
  const parent = dirname(manifestPath);
  const parentName = parent.split(sep).pop();
  return parentName === ".codex-plugin" || parentName === ".claude-plugin" || parentName === ".cursor-plugin"
    ? dirname(parent)
    : parent;
};

const projectForPath = (
  filePath: string,
  projects: WorkspaceDirectoryRecord[]
): WorkspaceDirectoryRecord | undefined =>
  projects
    .filter((project) => project.kind === "local")
    .sort((left, right) => right.path.length - left.path.length)
    .find((project) => filePath === project.path || filePath.startsWith(`${project.path}${sep}`));

const pluginIdFor = (name: string, root: string, codexHome: string): string => {
  const marketplaceRoot = join(codexHome, ".tmp", "marketplaces");
  const marketplaceRelative = relative(marketplaceRoot, root);
  const marketplace = marketplaceRelative && !marketplaceRelative.startsWith(`..${sep}`)
    ? marketplaceRelative.split(sep)[0]
    : "local";
  return `${name}@${marketplace}`;
};

const pluginIsEnabled = (pluginId: string, name: string, configs: ConfigSource[]): boolean => {
  let explicit: boolean | undefined;
  for (const config of configs) {
    const plugins = isRecord(config.values.plugins) ? config.values.plugins : {};
    for (const [key, rawConfig] of Object.entries(plugins)) {
      if (key !== pluginId && key !== name && !key.startsWith(`${name}@`)) {
        continue;
      }
      if (isRecord(rawConfig) && typeof rawConfig.enabled === "boolean") {
        explicit = rawConfig.enabled;
      }
    }
  }
  return explicit ?? true;
};

const loadPlugin = (
  manifestPath: string,
  codexHome: string,
  projects: WorkspaceDirectoryRecord[],
  configs: ConfigSource[],
  warnings: string[]
): PluginDescriptor | null => {
  const manifest = readJson(manifestPath, warnings);
  if (!manifest) {
    return null;
  }
  const root = pluginRootFromManifest(manifestPath);
  const manifestKind = pluginManifestKind(manifestPath);
  const name = nonEmptyString(manifest.name) ?? root.split(sep).pop() ?? "plugin";
  const project = projectForPath(root, projects);
  const scope: ImportScope = project ? "project" : "global";
  const interfaceValue = isRecord(manifest.interface) ? manifest.interface : {};
  const rawDefaultPrompt = interfaceValue.defaultPrompt ?? interfaceValue.default_prompt;
  const defaultPrompts = (typeof rawDefaultPrompt === "string"
    ? [rawDefaultPrompt]
    : asStringArray(rawDefaultPrompt))
    .slice(0, 3)
    .map((prompt) => prompt.trim().slice(0, 128))
    .filter(Boolean);
  const skillRoots = [
    join(root, "skills"),
    ...asPathList(manifest.skills).flatMap((path) => {
      const resolvedPath = resolvePluginDeclaredPath(root, path, warnings, "plugin Skills");
      return resolvedPath ? [resolvedPath] : [];
    }),
  ].filter((path, index, paths) => paths.indexOf(path) === index);
  const mcpDeclaration = manifest.mcpServers ?? manifest.mcp_servers;
  const mcpServers: Record<string, unknown> = {};
  const readMcpFile = (filePath: string): void => {
    if (!existsSync(filePath)) {
      return;
    }
    const parsed = readJson(filePath, warnings);
    if (!parsed) {
      return;
    }
    const nested = parsed.mcpServers ?? parsed.mcp_servers;
    Object.assign(mcpServers, isRecord(nested) ? nested : parsed);
  };

  if (mcpDeclaration === undefined && manifestKind !== "cursor") {
    readMcpFile(join(root, ".mcp.json"));
  } else if (typeof mcpDeclaration === "string") {
    const mcpPath = resolvePluginDeclaredPath(root, mcpDeclaration, warnings, "plugin MCP");
    if (mcpPath) {
      readMcpFile(mcpPath);
    }
  } else if (isRecord(mcpDeclaration)) {
    Object.assign(mcpServers, mcpDeclaration);
  }

  return {
    manifestKind,
    id: pluginIdFor(name, root, codexHome),
    name,
    root,
    manifestPath,
    scope,
    ...(project ? { projectId: project.directoryId, projectRoot: project.path } : {}),
    enabled: pluginIsEnabled(pluginIdFor(name, root, codexHome), name, configs),
    manifest,
    skillRoots,
    mcpServers,
    defaultPrompts,
  };
};

const collectPlugins = (
  codexHome: string,
  projects: WorkspaceDirectoryRecord[],
  configs: ConfigSource[],
  warnings: string[]
): PluginDescriptor[] => {
  const roots = [
    join(codexHome, ".tmp", "marketplaces"),
    join(codexHome, "plugins"),
    join(codexHome, ".agents", "plugins"),
    join(homedir(), ".agents", "plugins"),
    join(homedir(), "plugins"),
    ...projects.filter((project) => project.kind === "local").map((project) => join(project.path, ".agents", "plugins")),
    ...projects.filter((project) => project.kind === "local").map((project) => join(project.path, "plugins")),
  ];
  const manifestPaths = roots.flatMap((root) =>
    walkFiles(root, (filePath) => filePath.endsWith(`${sep}plugin.json`) && pluginManifestFile(filePath))
  );
  const seen = new Set<string>();
  return manifestPaths
    .map((path) => loadPlugin(path, codexHome, projects, configs, warnings))
    .filter((plugin): plugin is PluginDescriptor => {
      if (!plugin || seen.has(plugin.root)) {
        return false;
      }
      seen.add(plugin.root);
      return true;
    });
};

const collectConfigs = async (
  native: NativeBridge,
  codexHome: string,
  warnings: string[]
): Promise<{ configs: ConfigSource[]; projects: WorkspaceDirectoryRecord[] }> => {
  const configs: ConfigSource[] = [];
  const globalConfigPath = join(codexHome, "config.toml");
  const globalValues = readToml(globalConfigPath, warnings);
  if (globalValues) {
    configs.push({ scope: "global", configPath: globalConfigPath, values: globalValues });
  }

  const projects = await native.listWorkspaceDirectories();
  for (const project of projects.filter((item) => item.kind === "local")) {
    const configPath = join(project.path, ".codex", "config.toml");
    const values = readToml(configPath, warnings);
    if (values) {
      configs.push({
        scope: "project",
        configPath,
        projectId: project.directoryId,
        projectRoot: project.path,
        values,
      });
    }
  }
  return { configs, projects };
};

const readAgentsPrompt = (root: string): { path: string; content: string } | null => {
  for (const fileName of ["AGENTS.override.md", "AGENTS.md"]) {
    const path = join(root, fileName);
    if (!existsSync(path)) {
      continue;
    }
    try {
      const content = readFileSync(path, "utf8").trim();
      if (content) {
        return { path, content };
      }
    } catch {
      return null;
    }
  }
  return null;
};

const promptId = (source: ConfigSource, kind: string): string =>
  source.scope === "global" ? `codex:global:${kind}` : `codex:project:${source.projectId ?? "unknown"}:${kind}`;

const profilePromptId = (source: ConfigSource, profileName: string, kind: string): string =>
  promptId(source, "profile:" + safeSegment(profileName) + ":" + kind);

const collectPrompts = (
  codexHome: string,
  configs: ConfigSource[],
  projects: WorkspaceDirectoryRecord[],
  plugins: PluginDescriptor[],
  warnings: string[]
): ImportedPrompt[] => {
  const prompts = new Map<string, ImportedPrompt>();
  let order = 0;
  const add = (id: string, name: string, content: string): void => {
    const trimmed = content.trim();
    if (!trimmed) {
      return;
    }
    prompts.set(id, {
      promptId: id,
      name,
      content: trimmed,
      isActive: true,
      sortOrder: order++,
    });
  };

  const globalAgents = readAgentsPrompt(codexHome);
  if (globalAgents) {
    add("codex:global:agents", "Codex AGENTS.md", globalAgents.content);
  }

  const collectConfigPrompts = (
    config: ConfigSource,
    values: Record<string, unknown>,
    idFor: (kind: string) => string,
    labelSuffix: string
  ): void => {
    const labels: Array<[string, string, string]> = [
      ["instructions", "Codex instructions", "instructions"],
      ["developer_instructions", "Codex developer instructions", "developer-instructions"],
      ["compact_prompt", "Codex compact prompt", "compact-prompt"],
    ];
    for (const [key, name, idPart] of labels) {
      const value = nonEmptyString(values[key]);
      if (value) {
        add(idFor(idPart), name + labelSuffix, value);
      }
    }
    const filePrompts: Array<[string, string, string]> = [
      ["model_instructions_file", "Codex model instructions", "model-instructions"],
      ["experimental_compact_prompt_file", "Codex compact prompt file", "compact-prompt-file"],
    ];
    for (const [key, name, idPart] of filePrompts) {
      const declaredPath = nonEmptyString(values[key]);
      if (!declaredPath) {
        continue;
      }
      const path = resolveDeclaredPath(dirname(config.configPath), declaredPath);
      try {
        add(idFor(idPart), name + labelSuffix, readFileSync(path, "utf8"));
      } catch (error) {
        warnings.push("Unable to read Codex prompt file " + path + ": " + (error instanceof Error ? error.message : String(error)));
      }
    }
  };

  for (const config of configs) {
    const suffix = config.scope === "global" ? "" : " (" + (config.projectId ?? "unknown") + ")";
    collectConfigPrompts(config, config.values, (kind) => promptId(config, kind), suffix);
    const profiles = isRecord(config.values.profiles) ? config.values.profiles : {};
    for (const [profileName, rawProfile] of Object.entries(profiles)) {
      if (!isRecord(rawProfile)) {
        continue;
      }
      collectConfigPrompts(
        config,
        rawProfile,
        (kind) => profilePromptId(config, profileName, kind),
        suffix + " [" + profileName + "]"
      );
    }
    if (config.projectRoot) {
      const agents = readAgentsPrompt(config.projectRoot);
      if (agents) {
        add(promptId(config, "agents"), "Codex AGENTS.md (" + (config.projectId ?? "unknown") + ")", agents.content);
      }
    }
  }

  const configuredProjectIds = new Set(
    configs
      .filter((config) => config.scope === "project" && config.projectId)
      .map((config) => config.projectId as string)
  );
  for (const project of projects.filter((item) => item.kind === "local" && !configuredProjectIds.has(item.directoryId))) {
    const agents = readAgentsPrompt(project.path);
    if (agents) {
      add("codex:project:" + project.directoryId + ":agents", "Codex AGENTS.md (" + project.directoryId + ")", agents.content);
    }
  }

  for (const plugin of plugins.filter((item) => item.enabled)) {
    for (const [index, content] of plugin.defaultPrompts.entries()) {
      add(`codex-plugin:${plugin.id}:prompt:${index}`, `${plugin.name} prompt ${index + 1}`, content);
    }
  }
  return [...prompts.values()];
};

const toMcpInput = (
  name: string,
  raw: unknown,
  serverId: string,
  source: string,
  sortOrder: number,
  warnings: string[]
): McpServerConfigInput | null => {
  if (!isRecord(raw)) {
    return null;
  }
  const command = nonEmptyString(raw.command) ?? "";
  const url = nonEmptyString(raw.url) ?? "";
  if (!command && !url) {
    return null;
  }
  const startupTimeoutMs = typeof raw.startup_timeout_ms === "number"
    ? raw.startup_timeout_ms
    : typeof raw.startup_timeout_sec === "number"
      ? Math.round(raw.startup_timeout_sec * 1000)
      : typeof raw.timeout === "number"
        ? raw.timeout
        : undefined;
  if (typeof raw.tool_timeout_sec === "number") {
    warnings.push("MCP server " + name + " uses tool_timeout_sec, which is not representable in Snow App MCP settings");
  }
  const headers = asStringRecord(raw.http_headers ?? raw.headers);
  for (const [headerName, envName] of Object.entries(asStringRecord(raw.env_http_headers))) {
    const value = process.env[envName];
    if (value) {
      headers[headerName] = value;
    } else {
      warnings.push("MCP server " + name + " references missing environment variable " + envName + " for header " + headerName);
    }
  }
  const bearerTokenEnvVar = nonEmptyString(raw.bearer_token_env_var);
  if (bearerTokenEnvVar && !Object.keys(headers).some((key) => key.toLowerCase() === "authorization")) {
    const token = process.env[bearerTokenEnvVar];
    if (token) {
      headers.Authorization = "Bearer " + token;
    } else {
      warnings.push("MCP server " + name + " references missing bearer token environment variable " + bearerTokenEnvVar);
    }
  }
  return {
    serverId,
    name,
    transportType: url ? "http" : "stdio",
    url,
    command,
    argsJson: JSON.stringify(asStringArray(raw.args)),
    envJson: JSON.stringify(asStringRecord(raw.env)),
    headersJson: JSON.stringify(headers),
    enabled: toBoolean(raw.enabled, true),
    ...(startupTimeoutMs && startupTimeoutMs > 0 ? { timeoutMs: Math.round(startupTimeoutMs) } : {}),
    sortOrder,
    source,
  };
};

const collectMcpServers = (
  configs: ConfigSource[],
  plugins: PluginDescriptor[],
  warnings: string[]
): ImportedMcp[] => {
  const servers: ImportedMcp[] = [];
  for (const config of configs) {
    const declared = isRecord(config.values.mcp_servers) ? config.values.mcp_servers : {};
    for (const [index, [name, raw]] of Object.entries(declared).entries()) {
      const idPrefix = config.scope === "global" ? "codex:global" : `codex:project:${config.projectId}`;
      const input = toMcpInput(name, raw, `${idPrefix}:${name}`, CODEX_MCP_SOURCE, index, warnings);
      if (input) {
        servers.push({ scope: config.scope, projectId: config.projectId, input });
      }
    }
  }
  for (const plugin of plugins.filter((item) => item.enabled)) {
    for (const [index, [name, raw]] of Object.entries(plugin.mcpServers).entries()) {
      const input = toMcpInput(
        `${plugin.name}/${name}`,
        raw,
        `codex-plugin:${plugin.id}:${name}`,
        CODEX_PLUGIN_MCP_SOURCE,
        index,
        warnings
      );
      if (input) {
        servers.push({ scope: plugin.scope, projectId: plugin.projectId, input });
      }
    }
  }
  return servers;
};

const collectSkillCopies = (
  codexHome: string,
  projects: WorkspaceDirectoryRecord[],
  plugins: PluginDescriptor[]
): SkillCopy[] => {
  const copies: SkillCopy[] = [];
  const destinationPaths = new Set<string>();
  const addCopy = (sourceDir: string, destinationDir: string): void => {
    if (destinationPaths.has(destinationDir)) {
      return;
    }
    destinationPaths.add(destinationDir);
    copies.push({ sourceDir, destinationDir });
  };
  const globalDestination = join(SNOW_CLI_CONFIG_DIR, "skills", "codex");
  const globalSkillRoots = [
    join(codexHome, "skills"),
    join(homedir(), ".agents", "skills"),
  ];
  for (const sourceRoot of globalSkillRoots) {
    for (const skillDir of collectSkillDirectories(sourceRoot)) {
      const rel = relative(sourceRoot, skillDir);
      addCopy(skillDir, join(globalDestination, rel));
    }
  }
  for (const project of projects.filter((item) => item.kind === "local")) {
    const projectRoot = project.path;
    const destinationRoot = join(projectRoot, ".snow", "skills", "codex");
    for (const sourceRoot of [join(projectRoot, ".codex", "skills"), join(projectRoot, ".agents", "skills")]) {
      for (const skillDir of collectSkillDirectories(sourceRoot)) {
        addCopy(skillDir, join(destinationRoot, relative(sourceRoot, skillDir)));
      }
    }
  }
  for (const plugin of plugins.filter((item) => item.enabled)) {
    for (const skillRoot of plugin.skillRoots) {
      const destinationBase = plugin.scope === "project" && plugin.projectRoot
        ? join(plugin.projectRoot, ".snow", "skills", "codex-plugins", safeSegment(plugin.id))
        : join(SNOW_CLI_CONFIG_DIR, "skills", "codex-plugins", safeSegment(plugin.id));
      for (const skillDir of collectSkillDirectories(skillRoot)) {
        addCopy(skillDir, join(destinationBase, relative(skillRoot, skillDir)));
      }
    }
  }
  return copies;
};

const buildContext = async (native: NativeBridge): Promise<CodexImportContext> => {
  const codexHome = getCodexHome();
  const warnings: string[] = [];
  const { configs, projects } = await collectConfigs(native, codexHome, warnings);
  const plugins = collectPlugins(codexHome, projects, configs, warnings);
  const mcpServers = collectMcpServers(configs, plugins, warnings);
  const prompts = collectPrompts(codexHome, configs, projects, plugins, warnings);
  const skills = collectSkillCopies(codexHome, projects, plugins);
  const configPath = getCodexConfigPath();
  const globalInstructionsPath = readAgentsPrompt(codexHome)?.path ?? null;
  const preview: CodexImportPreview = {
    codexHome,
    configPath,
    configFound: existsSync(configPath),
    globalInstructionsPath,
    projectConfigCount: configs.filter((config) => config.scope === "project").length,
    mcpServerCount: mcpServers.filter((server) => server.scope === "global").length,
    projectMcpServerCount: mcpServers.filter((server) => server.scope === "project").length,
    skillCount: skills.length,
    pluginCount: plugins.length,
    pluginSkillCount: skills.filter((skill) => skill.destinationDir.includes(`${sep}codex-plugins${sep}`)).length,
    pluginMcpServerCount: mcpServers.filter((server) => server.input.source === CODEX_PLUGIN_MCP_SOURCE).length,
    promptCount: prompts.length,
    warnings,
  };
  const codexHomeFound = existsSync(codexHome);
  const globalConfig = configs.find((config) => config.scope === "global");
  const globalCodexMcpSourceFound = isRecord(globalConfig?.values.mcp_servers);
  const globalPluginMcpSourceFound = plugins.some((plugin) => plugin.scope === "global");
  const projectCodexMcpSourceIds = new Set(
    configs
      .filter(
        (config) =>
          config.scope === "project" &&
          config.projectId &&
          isRecord(config.values.mcp_servers)
      )
      .map((config) => config.projectId as string)
  );
  const projectPluginMcpSourceIds = new Set(
    plugins
      .filter((plugin) => plugin.scope === "project" && plugin.projectId)
      .map((plugin) => plugin.projectId as string)
  );
  if (!codexHomeFound) {
    warnings.push(`Codex home not found: ${codexHome}`);
  }
  return {
    preview,
    globalCodexMcpSourceFound,
    globalPluginMcpSourceFound,
    projectCodexMcpSourceIds,
    projectPluginMcpSourceIds,
    codexPromptSourceFound: codexHomeFound,
    pluginPromptSourceFound: plugins.length > 0,
    mcpServers,
    prompts,
    skills,
    plugins,
  };
};

const persistMcpServers = async (
  native: NativeBridge,
  servers: ImportedMcp[],
  globalCodexMcpSourceFound: boolean,
  globalPluginMcpSourceFound: boolean,
  projectCodexMcpSourceIds: Set<string>,
  projectPluginMcpSourceIds: Set<string>
): Promise<{ global: number; project: number }> => {
  const globalServers = servers.filter((server) => server.scope === "global");
  const projectServers = servers.filter((server) => server.scope === "project" && server.projectId);
  for (const server of globalServers) {
    await native.upsertMcpServerConfig(server.input);
  }
  if (globalCodexMcpSourceFound || globalPluginMcpSourceFound) {
    const existingGlobal = await native.listMcpServerConfigs();
    const nextCodexIds = new Set(
      globalServers
        .filter((server) => server.input.source === CODEX_MCP_SOURCE)
        .map((server) => server.input.serverId)
    );
    const nextPluginIds = new Set(
      globalServers
        .filter((server) => server.input.source === CODEX_PLUGIN_MCP_SOURCE)
        .map((server) => server.input.serverId)
    );
    for (const existing of existingGlobal) {
      if (
        (existing.source === CODEX_MCP_SOURCE &&
          globalCodexMcpSourceFound &&
          !nextCodexIds.has(existing.serverId)) ||
        (existing.source === CODEX_PLUGIN_MCP_SOURCE &&
          globalPluginMcpSourceFound &&
          !nextPluginIds.has(existing.serverId))
      ) {
        await native.deleteMcpServerConfig(existing.serverId);
      }
    }
  }

  const projectIds = new Set([...projectCodexMcpSourceIds, ...projectPluginMcpSourceIds]);
  for (const projectId of projectIds) {
    const scoped = projectServers.filter((server) => server.projectId === projectId);
    for (const server of scoped) {
      await native.upsertProjectMcpServerConfig(projectId, server.input);
    }
    if (projectCodexMcpSourceIds.has(projectId) || projectPluginMcpSourceIds.has(projectId)) {
      const existing = await native.listProjectMcpServerConfigs(projectId);
      const nextCodexIds = new Set(
        scoped
          .filter((server) => server.input.source === CODEX_MCP_SOURCE)
          .map((server) => server.input.serverId)
      );
      const nextPluginIds = new Set(
        scoped
          .filter((server) => server.input.source === CODEX_PLUGIN_MCP_SOURCE)
          .map((server) => server.input.serverId)
      );
      for (const item of existing) {
        if (
          (item.source === CODEX_MCP_SOURCE &&
            projectCodexMcpSourceIds.has(projectId) &&
            !nextCodexIds.has(item.serverId)) ||
          (item.source === CODEX_PLUGIN_MCP_SOURCE &&
            projectPluginMcpSourceIds.has(projectId) &&
            !nextPluginIds.has(item.serverId))
        ) {
          await native.deleteProjectMcpServerConfig(projectId, item.serverId);
        }
      }
    }
  }
  return { global: globalServers.length, project: projectServers.length };
};

const persistPrompts = async (
  native: NativeBridge,
  prompts: ImportedPrompt[],
  codexPromptSourceFound: boolean,
  pluginPromptSourceFound: boolean
): Promise<void> => {
  if (!codexPromptSourceFound && !pluginPromptSourceFound && prompts.length === 0) {
    return;
  }
  const nextIds = new Set(prompts.map((prompt) => prompt.promptId));
  const existing = await native.listSystemPrompts();
  for (const prompt of existing) {
    if (
      ((prompt.promptId.startsWith("codex:") &&
        codexPromptSourceFound) ||
        (prompt.promptId.startsWith("codex-plugin:") &&
          pluginPromptSourceFound)) &&
      !nextIds.has(prompt.promptId)
    ) {
      await native.deleteSystemPrompt(prompt.promptId);
    }
  }
  for (const prompt of prompts) {
    await native.upsertSystemPrompt(prompt);
  }
};

const copySkills = (skills: SkillCopy): void => {
  mkdirSync(dirname(skills.destinationDir), { recursive: true });
  cpSync(skills.sourceDir, skills.destinationDir, { recursive: true, force: true });
};

const persistPluginRegistry = (plugins: PluginDescriptor[]): void => {
  mkdirSync(SNOW_CLI_CONFIG_DIR, { recursive: true });
  const records = plugins.map((plugin) => ({
    id: plugin.id,
    name: plugin.name,
    path: plugin.root,
    manifestPath: plugin.manifestPath,
    scope: plugin.scope,
    projectId: plugin.projectId ?? null,
    enabled: plugin.enabled,
    importedAt: new Date().toISOString(),
    skillRoots: plugin.skillRoots,
    mcpServerNames: Object.keys(plugin.mcpServers),
    promptCount: plugin.defaultPrompts.length,
    manifestKind: plugin.manifestKind,
  }));
  writeFileSync(CODEX_PLUGIN_REGISTRY_FILE, `${JSON.stringify({ version: 1, plugins: records }, null, 2)}\n`, "utf8");
};

export const previewCodexImport = async (native: NativeBridge): Promise<CodexImportPreview> =>
  (await buildContext(native)).preview;

export const importCodex = async (native: NativeBridge): Promise<CodexImportResult> => {
  const context = await buildContext(native);
  const mcpCounts =
    context.globalCodexMcpSourceFound ||
    context.globalPluginMcpSourceFound ||
    context.projectCodexMcpSourceIds.size > 0 ||
    context.projectPluginMcpSourceIds.size > 0
    ? await persistMcpServers(
        native,
        context.mcpServers,
        context.globalCodexMcpSourceFound,
        context.globalPluginMcpSourceFound,
        context.projectCodexMcpSourceIds,
        context.projectPluginMcpSourceIds
      )
    : { global: 0, project: 0 };
  await persistPrompts(
    native,
    context.prompts,
    context.codexPromptSourceFound,
    context.pluginPromptSourceFound
  );
  let importedSkills = 0;
  for (const skill of context.skills) {
    try {
      copySkills(skill);
      importedSkills += 1;
    } catch (error) {
      context.preview.warnings.push(`Unable to import Skill ${skill.sourceDir}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (context.plugins.length > 0) {
    persistPluginRegistry(context.plugins);
  }
  return {
    ...context.preview,
    importedMcpServers: mcpCounts.global,
    importedProjectMcpServers: mcpCounts.project,
    importedSkills,
    importedPlugins: context.plugins.length,
    importedPrompts: context.prompts.length,
  };
};
