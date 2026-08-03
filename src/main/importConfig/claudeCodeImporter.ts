import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type {
  NativeBridge,
  SystemPromptItemInput,
  WorkspaceDirectoryRecord,
} from "../native/types";
import { isRecord } from "../utils/value";
import {
  asStringArray,
  asStringRecord,
  collectSkillDirectories,
  createMcpInput,
  createPrompt,
  nonEmptyString,
  projectPathMatches,
  readJson,
  readText,
  safeSegment,
  type ImportedMcp,
  uniquePaths,
  walkFiles,
} from "./utils";
import {
  buildImportDiscovery,
  hashImportPath,
  hashImportValue,
  skillLogicalId,
  type ImportCandidateInput,
  type ImportSourceDiscovery,
} from "./discovery";
import type { ImportSource, ReadonlyImportResult } from "../../shared/importDiscovery";
import {
  selectionForInput,
  skillDestination,
  type ResolvedImportAction,
  type SelectedImportCandidate,
} from "./selectedImport";

const SOURCE: "claude-code" = "claude-code";

type ConfigSource = {
  scope: "global" | "project";
  path: string;
  values: Record<string, unknown>;
  projectId?: string;
  projectRoot?: string;
};

type ImportContext = {
  source: ImportSource;
  mcpServers: ImportedMcp[];
  prompts: SystemPromptItemInput[];
  skills: DiscoveredSkill[];
};

type DiscoveredSkill = {
  sourceDir: string;
  scope: "global" | "project";
  projectId?: string;
  projectRoot?: string;
};

const getClaudeHome = (): string => {
  const configuredHome = process.env.CLAUDE_CONFIG_DIR?.trim();
  return configuredHome ? resolve(configuredHome) : join(homedir(), ".claude");
};

const expandEnvironment = (
  value: string,
  warnings: string,
  warningSink: string[]
): string =>
  value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\}/g, (_match, name, _defaultPart, defaultValue) => {
    const replacement = process.env[name] ?? defaultValue;
    if (replacement === undefined) {
      warningSink.push(`${warnings} references missing environment variable ${name}`);
      return "";
    }
    return replacement;
  });

const expandStringRecord = (
  record: Record<string, string>,
  label: string,
  warnings: string[]
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      expandEnvironment(value, `${label} field ${key}`, warnings),
    ])
  );

const toMcpServer = (
  name: string,
  raw: unknown,
  serverId: string,
  scope: "global" | "project",
  projectId: string | undefined,
  sortOrder: number,
  warnings: string[]
): ImportedMcp | null => {
  if (!isRecord(raw)) {
    return null;
  }
  const type = nonEmptyString(raw.type) ?? "stdio";
  if (type === "ws") {
    warnings.push(`Skipping Claude Code WebSocket MCP server ${name}: Snow App supports stdio and HTTP only`);
    return null;
  }
  if (type === "sse") {
    warnings.push(`Skipping Claude Code SSE MCP server ${name}: Snow App supports streamable HTTP only`);
    return null;
  }
  if (type !== "stdio" && type !== "http" && type !== "streamable-http") {
    warnings.push(`Skipping Claude Code MCP server ${name}: unsupported transport ${type}`);
    return null;
  }
  if (nonEmptyString(raw.headersHelper)) {
    warnings.push(`Claude Code MCP server ${name} uses headersHelper, which Snow App cannot import`);
  }
  const transportType = type === "stdio" ? "stdio" : "http";
  const input = createMcpInput({
    serverId,
    name,
    source: SOURCE,
    sortOrder,
    transportType,
    url: transportType === "http" && typeof raw.url === "string"
      ? expandEnvironment(raw.url, `Claude Code MCP server ${name} URL`, warnings)
      : "",
    command: transportType === "stdio" && typeof raw.command === "string"
      ? expandEnvironment(raw.command, `Claude Code MCP server ${name} command`, warnings)
      : "",
    args: asStringArray(raw.args).map((argument) =>
      expandEnvironment(argument, `Claude Code MCP server ${name} argument`, warnings)
    ),
    env: expandStringRecord(asStringRecord(raw.env), `Claude Code MCP server ${name} environment`, warnings),
    headers: expandStringRecord(asStringRecord(raw.headers), `Claude Code MCP server ${name} header`, warnings),
    enabled: raw.enabled,
    timeoutMs: typeof raw.timeout === "number" ? raw.timeout : undefined,
  });
  return input ? { scope, projectId, input } : null;
};

const collectClaudeJsonSources = (
  claudeJson: Record<string, unknown> | null,
  projects: WorkspaceDirectoryRecord[]
): ConfigSource[] => {
  if (!claudeJson) {
    return [];
  }
  const sources: ConfigSource[] = [{ scope: "global", path: join(homedir(), ".claude.json"), values: claudeJson }];
  const configuredProjects = isRecord(claudeJson.projects) ? claudeJson.projects : {};
  for (const project of projects.filter((item) => item.kind === "local")) {
    const config = Object.entries(configuredProjects).find(([path]) =>
      projectPathMatches(resolve(path), resolve(project.path))
    )?.[1];
    if (isRecord(config)) {
      sources.push({
        scope: "project",
        path: join(homedir(), ".claude.json"),
        values: config,
        projectId: project.directoryId,
        projectRoot: project.path,
      });
    }
  }
  return sources;
};

const collectProjectSources = (
  projects: WorkspaceDirectoryRecord[],
  warnings: string[]
): ConfigSource[] =>
  projects
    .filter((project) => project.kind === "local")
    .flatMap((project) => {
      const path = join(project.path, ".mcp.json");
      const values = readJson(path, warnings);
      return values
        ? [{ scope: "project" as const, path, values, projectId: project.directoryId, projectRoot: project.path }]
        : [];
    });

const collectMcpServers = (
  sources: ConfigSource[],
  warnings: string[]
): { servers: ImportedMcp[]; globalFound: boolean; projectIds: Set<string> } => {
  const servers = new Map<string, ImportedMcp>();
  let globalFound = false;
  const projectIds = new Set<string>();
  for (const source of sources) {
    const declared = isRecord(source.values.mcpServers) ? source.values.mcpServers : null;
    if (!declared) {
      continue;
    }
    if (source.scope === "global") {
      globalFound = true;
    } else if (source.projectId) {
      projectIds.add(source.projectId);
    }
    for (const [index, [name, raw]] of Object.entries(declared).entries()) {
      const id = source.scope === "global"
        ? `${SOURCE}:global:${name}`
        : `${SOURCE}:project:${source.projectId}:${name}`;
      const server = toMcpServer(
        name,
        raw,
        id,
        source.scope,
        source.projectId,
        index,
        warnings
      );
      if (server) {
        servers.set(id, server);
      }
    }
  }
  return { servers: [...servers.values()], globalFound, projectIds };
};

const addPrompt = (
  prompts: Map<string, SystemPromptItemInput>,
  id: string,
  name: string,
  content: string | null
): void => {
  if (!content) {
    return;
  }
  const prompt = createPrompt(id, name, content, prompts.size);
  if (prompt) {
    prompts.set(id, prompt);
  }
};

const collectPrompts = (
  claudeHome: string,
  projects: WorkspaceDirectoryRecord[],
  warnings: string[]
): { prompts: SystemPromptItemInput[]; instructionPaths: string[] } => {
  const prompts = new Map<string, SystemPromptItemInput>();
  const instructionPaths: string[] = [];
  const addFile = (id: string, name: string, path: string): void => {
    const content = readText(path, warnings);
    if (content) {
      instructionPaths.push(path);
      addPrompt(prompts, id, name, content);
    }
  };

  addFile(`${SOURCE}:global:claude-md`, "Claude Code CLAUDE.md", join(claudeHome, "CLAUDE.md"));
  for (const path of walkFiles(join(claudeHome, "rules"), (file) => file.endsWith(".md"))) {
    addFile(`${SOURCE}:global:rule:${safeSegment(path)}`, "Claude Code rule", path);
  }
  for (const path of walkFiles(join(claudeHome, "commands"), (file) => file.endsWith(".md"))) {
    addFile(`${SOURCE}:global:command:${safeSegment(path)}`, "Claude Code command", path);
  }

  for (const project of projects.filter((item) => item.kind === "local")) {
    addFile(
      `${SOURCE}:project:${project.directoryId}:claude-md`,
      `Claude Code CLAUDE.md (${project.directoryId})`,
      join(project.path, "CLAUDE.md")
    );
    addFile(
      `${SOURCE}:project:${project.directoryId}:claude-dir-md`,
      `Claude Code .claude/CLAUDE.md (${project.directoryId})`,
      join(project.path, ".claude", "CLAUDE.md")
    );
    for (const [kind, root] of [
      ["rule", join(project.path, ".claude", "rules")],
      ["command", join(project.path, ".claude", "commands")],
    ] as const) {
      for (const path of walkFiles(root, (file) => file.endsWith(".md"))) {
        addFile(
          `${SOURCE}:project:${project.directoryId}:${kind}:${safeSegment(path)}`,
          `Claude Code ${kind}`,
          path
        );
      }
    }
  }
  return { prompts: [...prompts.values()], instructionPaths };
};

const collectSkills = (
  claudeHome: string,
  projects: WorkspaceDirectoryRecord[]
): DiscoveredSkill[] => {
  const skills: DiscoveredSkill[] = [];
  const sourcePaths = new Set<string>();
  const addRoot = (
    sourceRoot: string,
    scope: "global" | "project",
    project?: WorkspaceDirectoryRecord
  ): void => {
    for (const sourceDir of collectSkillDirectories(sourceRoot)) {
      const key = resolve(sourceDir);
      if (sourcePaths.has(key)) {
        continue;
      }
      sourcePaths.add(key);
      skills.push({
        sourceDir,
        scope,
        ...(project ? { projectId: project.directoryId, projectRoot: project.path } : {}),
      });
    }
  };
  addRoot(join(claudeHome, "skills"), "global");
  for (const project of projects.filter((item) => item.kind === "local")) {
    addRoot(join(project.path, ".claude", "skills"), "project", project);
  }
  return skills;
};

const buildContext = async (native: NativeBridge): Promise<ImportContext> => {
  const claudeHome = getClaudeHome();
  const claudeJsonPath = join(homedir(), ".claude.json");
  const warnings: string[] = [];
  const projects = await native.listWorkspaceDirectories();
  const claudeJson = readJson(claudeJsonPath, warnings);
  const sources = [
    ...collectProjectSources(projects, warnings),
    ...collectClaudeJsonSources(claudeJson, projects),
  ];
  const mcp = collectMcpServers(sources, warnings);
  const promptData = collectPrompts(claudeHome, projects, warnings);
  const skills = collectSkills(claudeHome, projects);
  const configPaths = [
    { label: "User configuration", path: claudeJsonPath, found: existsSync(claudeJsonPath) },
    { label: "User settings", path: join(claudeHome, "settings.json"), found: existsSync(join(claudeHome, "settings.json")) },
  ];
  const source: ImportSource = {
    provider: SOURCE,
    sourceHome: claudeHome,
    sourceFound: existsSync(claudeHome) || existsSync(claudeJsonPath),
    configPaths,
    instructionPaths: uniquePaths(promptData.instructionPaths).map((path) => ({
      label: "Imported instruction",
      path,
      found: true,
    })),
    projectConfigCount: sources.filter((source) => source.scope === "project").length,
    warnings,
  };
  if (!source.sourceFound) {
    warnings.push(`Claude Code configuration not found: ${claudeHome}`);
  }
  return {
    source,
    mcpServers: mcp.servers,
    prompts: promptData.prompts,
    skills,
  };
};

export const discoverClaudeCodeImport = async (
  native: NativeBridge
): Promise<ImportSourceDiscovery> => {
  const context = await buildContext(native);
  const candidates: ImportCandidateInput[] = [
    ...context.mcpServers.map((server) => ({
      type: "mcp" as const,
      provider: SOURCE,
      scope: server.scope,
      originPath: context.source.sourceHome,
      logicalId: server.input.name,
      contentHash: hashImportValue({
        transportType: server.input.transportType,
        url: server.input.url,
        command: server.input.command,
        argsJson: server.input.argsJson,
        envJson: server.input.envJson,
        headersJson: server.input.headersJson,
      }),
      ...(server.projectId ? { projectId: server.projectId } : {}),
    })),
    ...context.prompts.map((prompt) => ({
      type: "prompt" as const,
      provider: SOURCE,
      scope: prompt.promptId.includes(":project:") ? "project" as const : "global" as const,
      originPath: context.source.sourceHome,
      logicalId: prompt.promptId,
      contentHash: hashImportValue(prompt.content),
    })),
    ...context.skills.map((skill) => ({
      type: "skill" as const,
      provider: SOURCE,
      scope: skill.scope,
      originPath: skill.sourceDir,
      logicalId: skillLogicalId(skill.sourceDir),
      contentHash: hashImportPath(skill.sourceDir),
      ...(skill.projectId ? { projectId: skill.projectId } : {}),
      ...(skill.projectRoot ? { projectRoot: skill.projectRoot } : {}),
    })),
  ];
  return { source: context.source, candidates };
};

export const resolveClaudeCodeSelectedImports = async (
  native: NativeBridge,
  selected: SelectedImportCandidate[]
): Promise<{ actions: ResolvedImportAction[]; warnings: string[] }> => {
  const context = await buildContext(native);
  const actions: ResolvedImportAction[] = [];
  for (const server of context.mcpServers) {
    const input: ImportCandidateInput = {
      type: "mcp",
      provider: SOURCE,
      scope: server.scope,
      originPath: context.source.sourceHome,
      logicalId: server.input.name,
      contentHash: hashImportValue({
        transportType: server.input.transportType,
        url: server.input.url,
        command: server.input.command,
        argsJson: server.input.argsJson,
        envJson: server.input.envJson,
        headersJson: server.input.headersJson,
      }),
      ...(server.projectId ? { projectId: server.projectId } : {}),
    };
    const candidate = selectionForInput(input, selected);
    if (candidate) {
      actions.push({
        candidate,
        scope: server.scope,
        ...(server.projectId ? { projectId: server.projectId } : {}),
        mcpInput: server.input,
      });
    }
  }
  for (const prompt of context.prompts) {
    const input: ImportCandidateInput = {
      type: "prompt",
      provider: SOURCE,
      scope: prompt.promptId.includes(":project:") ? "project" : "global",
      originPath: context.source.sourceHome,
      logicalId: prompt.promptId,
      contentHash: hashImportValue(prompt.content),
    };
    const candidate = selectionForInput(input, selected);
    if (candidate) {
      actions.push({ candidate, scope: input.scope, promptInput: prompt });
    }
  }
  for (const skill of context.skills) {
    const input: ImportCandidateInput = {
      type: "skill",
      provider: SOURCE,
      scope: skill.scope,
      originPath: skill.sourceDir,
      logicalId: skillLogicalId(skill.sourceDir),
      contentHash: hashImportPath(skill.sourceDir),
      ...(skill.projectId ? { projectId: skill.projectId } : {}),
      ...(skill.projectRoot ? { projectRoot: skill.projectRoot } : {}),
    };
    const candidate = selectionForInput(input, selected);
    if (candidate) {
      actions.push({
        candidate,
        scope: skill.scope,
        ...(skill.projectId ? { projectId: skill.projectId } : {}),
        skill: {
          sourceDir: skill.sourceDir,
          destinationDir: skillDestination(SOURCE, skill.sourceDir, skill.scope, skill.projectRoot),
        },
      });
    }
  }
  return { actions, warnings: context.source.warnings };
};

export const previewClaudeCodeImport = async (
  native: NativeBridge
): Promise<ReturnType<typeof buildImportDiscovery>> =>
  buildImportDiscovery([await discoverClaudeCodeImport(native)]);

export const importClaudeCode = async (
  native: NativeBridge
): Promise<ReadonlyImportResult> => ({
  ...await previewClaudeCodeImport(native),
  applied: false,
});
