import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  NativeBridge,
  SystemPromptItemInput,
  WorkspaceDirectoryRecord,
} from "../native/types";
import { SNOW_CLI_CONFIG_DIR } from "../snowCli/paths";
import { isRecord } from "../utils/value";
import type { ExternalImportPreview, ExternalImportResult } from "./types";
import {
  asStringArray,
  asStringRecord,
  collectSkillDirectories,
  copySkills,
  createMcpInput,
  createPrompt,
  destinationForSkill,
  nonEmptyString,
  persistImportedMcpServers,
  persistImportedPrompts,
  readJson,
  readText,
  safeSegment,
  type ImportedMcp,
  type SkillCopy,
  uniquePaths,
  walkFiles,
} from "./utils";

const SOURCE = "opencode";
const SOURCE_PREFIX = `${SOURCE}:`;

type ConfigSource = {
  scope: "global" | "project";
  path: string;
  root: string;
  values: Record<string, unknown>;
  projectId?: string;
  projectRoot?: string;
};

type ImportContext = {
  preview: ExternalImportPreview;
  mcpServers: ImportedMcp[];
  prompts: SystemPromptItemInput[];
  skills: SkillCopy[];
  globalMcpSourceFound: boolean;
  projectMcpSourceIds: Set<string>;
};

const getOpenCodeConfigHome = (): string => {
  const configuredHome = process.env.OPENCODE_CONFIG_DIR?.trim();
  if (configuredHome) {
    return resolve(configuredHome);
  }
  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
  return join(xdgConfigHome ? resolve(xdgConfigHome) : join(homedir(), ".config"), "opencode");
};

const resolveDeclaredPath = (root: string, declaredPath: string): string =>
  isAbsolute(declaredPath) ? resolve(declaredPath) : resolve(root, declaredPath);

const readConfig = (
  path: string,
  scope: "global" | "project",
  root: string,
  warnings: string[],
  project?: WorkspaceDirectoryRecord
): ConfigSource | null => {
  const values = readJson(path, warnings, true);
  return values
    ? {
        scope,
        path,
        root,
        values,
        ...(project ? { projectId: project.directoryId, projectRoot: project.path } : {}),
      }
    : null;
};

const configCandidates = (root: string): string[] => [
  join(root, "config.json"),
  join(root, "opencode.json"),
  join(root, "opencode.jsonc"),
];

const collectConfigSources = (
  configHome: string,
  projects: WorkspaceDirectoryRecord[],
  warnings: string[]
): ConfigSource[] => {
  const sources: ConfigSource[] = [];
  for (const path of configCandidates(configHome)) {
    const source = readConfig(path, "global", configHome, warnings);
    if (source) {
      sources.push(source);
    }
  }
  const legacyHome = join(homedir(), ".opencode");
  for (const path of [join(legacyHome, "opencode.json"), join(legacyHome, "opencode.jsonc")]) {
    const source = readConfig(path, "global", legacyHome, warnings);
    if (source) {
      sources.push(source);
    }
  }
  for (const project of projects.filter((item) => item.kind === "local")) {
    for (const path of [
      join(project.path, "opencode.json"),
      join(project.path, "opencode.jsonc"),
      join(project.path, ".opencode", "opencode.json"),
      join(project.path, ".opencode", "opencode.jsonc"),
    ]) {
      const source = readConfig(path, "project", dirname(path), warnings, project);
      if (source) {
        sources.push(source);
      }
    }
  }
  return sources;
};

const toMcpServer = (
  name: string,
  raw: unknown,
  source: ConfigSource,
  sortOrder: number,
  warnings: string[]
): ImportedMcp | null => {
  if (!isRecord(raw) || raw.type === undefined) {
    return null;
  }
  const type = nonEmptyString(raw.type);
  if (type !== "local" && type !== "remote") {
    warnings.push(`Skipping OpenCode MCP server ${name}: unsupported type ${String(raw.type)}`);
    return null;
  }
  const serverId = source.scope === "global"
    ? `${SOURCE}:global:${name}`
    : `${SOURCE}:project:${source.projectId}:${name}`;
  let input;
  if (type === "local") {
    const command = asStringArray(raw.command);
    input = createMcpInput({
      serverId,
      name,
      source: SOURCE,
      sortOrder,
      transportType: "stdio",
      command: command[0],
      args: command.slice(1),
      env: asStringRecord(raw.environment),
      enabled: raw.enabled,
      timeoutMs: typeof raw.timeout === "number" ? raw.timeout : undefined,
    });
  } else {
    input = createMcpInput({
      serverId,
      name,
      source: SOURCE,
      sortOrder,
      transportType: "http",
      url: typeof raw.url === "string" ? raw.url : "",
      headers: asStringRecord(raw.headers),
      enabled: raw.enabled,
      timeoutMs: typeof raw.timeout === "number" ? raw.timeout : undefined,
    });
  }
  if (!input) {
    warnings.push(`Skipping OpenCode MCP server ${name}: incomplete ${type} configuration`);
    return null;
  }
  return { scope: source.scope, projectId: source.projectId, input };
};

const collectMcpServers = (
  sources: ConfigSource[],
  warnings: string[]
): { servers: ImportedMcp[]; globalFound: boolean; projectIds: Set<string> } => {
  const servers = new Map<string, ImportedMcp>();
  let globalFound = false;
  const projectIds = new Set<string>();
  for (const source of sources) {
    const declared = isRecord(source.values.mcp) ? source.values.mcp : null;
    if (!declared) {
      continue;
    }
    if (source.scope === "global") {
      globalFound = true;
    } else if (source.projectId) {
      projectIds.add(source.projectId);
    }
    for (const [index, [name, raw]] of Object.entries(declared).entries()) {
      const server = toMcpServer(name, raw, source, index, warnings);
      if (server) {
        servers.set(server.input.serverId, server);
        continue;
      }
      if (isRecord(raw) && typeof raw.enabled === "boolean") {
        const serverId = source.scope === "global"
          ? `${SOURCE}:global:${name}`
          : `${SOURCE}:project:${source.projectId}:${name}`;
        const existing = servers.get(serverId);
        if (existing) {
          servers.set(serverId, {
            ...existing,
            input: { ...existing.input, enabled: raw.enabled },
          });
        }
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

const globPatternToRegExp = (pattern: string): RegExp => {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === "*" && next === "*") {
      if (pattern[index + 2] === "/") {
        expression += "(?:.*/)?";
        index += 2;
      } else {
        expression += ".*";
        index += 1;
      }
    } else if (char === "*") {
      expression += "[^/]*";
    } else if (char === "?") {
      expression += "[^/]";
    } else {
      expression += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${expression}$`);
};

const resolveInstructionPaths = (source: ConfigSource, declaredPath: string): string[] => {
  const root = dirname(source.path);
  if (!/[?*]/.test(declaredPath)) {
    return [resolveDeclaredPath(root, declaredPath)];
  }
  const normalizedPattern = declaredPath.replaceAll("\\", "/").replace(/^\.\//, "");
  const matches = globPatternToRegExp(normalizedPattern);
  return walkFiles(root, (path) =>
    matches.test(relative(root, path).split(sep).join("/")),
    20
  );
};

const collectPrompts = (
  sources: ConfigSource[],
  configHome: string,
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
  const addDirectoryPrompts = (source: ConfigSource, kind: "agent" | "command", root: string): void => {
    for (const path of walkFiles(root, (file) => file.endsWith(".md"))) {
      const id = source.scope === "global"
        ? `${SOURCE}:global:${kind}:${safeSegment(path)}`
        : `${SOURCE}:project:${source.projectId}:${kind}:${safeSegment(path)}`;
      addFile(id, `OpenCode ${kind}`, path);
    }
  };

  for (const source of sources) {
    const idPrefix = source.scope === "global"
      ? `${SOURCE}:global`
      : `${SOURCE}:project:${source.projectId}`;
    const instructions = asStringArray(source.values.instructions);
    instructions.forEach((instruction, index) => {
      resolveInstructionPaths(source, instruction).forEach((path, pathIndex) => {
        addFile(
          `${idPrefix}:instruction:${index}:${pathIndex}`,
          "OpenCode instruction",
          path
        );
      });
    });
    const commands = isRecord(source.values.command) ? source.values.command : {};
    for (const [name, command] of Object.entries(commands)) {
      if (isRecord(command) && typeof command.template === "string") {
        addPrompt(prompts, `${idPrefix}:command:${safeSegment(name)}`, `OpenCode command ${name}`, command.template);
      }
    }
    const agents = isRecord(source.values.agent) ? source.values.agent : {};
    for (const [name, agent] of Object.entries(agents)) {
      if (isRecord(agent) && typeof agent.prompt === "string") {
        addPrompt(prompts, `${idPrefix}:agent:${safeSegment(name)}`, `OpenCode agent ${name}`, agent.prompt);
      }
    }
    addDirectoryPrompts(source, "agent", join(source.root, "agent"));
    addDirectoryPrompts(source, "agent", join(source.root, "agents"));
    addDirectoryPrompts(source, "command", join(source.root, "command"));
    addDirectoryPrompts(source, "command", join(source.root, "commands"));
  }
  for (const path of walkFiles(join(configHome, "instructions"), (file) => file.endsWith(".md"))) {
    addFile(`${SOURCE}:global:instruction:${safeSegment(path)}`, "OpenCode instruction", path);
  }
  return { prompts: [...prompts.values()], instructionPaths };
};

const collectSkills = (sources: ConfigSource[]): SkillCopy[] => {
  const copies: SkillCopy[] = [];
  const destinations = new Set<string>();
  const addRoot = (source: ConfigSource, sourceRoot: string): void => {
    const destinationRoot = source.scope === "global"
      ? join(SNOW_CLI_CONFIG_DIR, "skills", SOURCE)
      : join(source.projectRoot ?? "", ".snow", "skills", SOURCE);
    for (const sourceDir of collectSkillDirectories(sourceRoot)) {
      const destinationDir = destinationForSkill(sourceRoot, sourceDir, destinationRoot);
      if (destinations.has(destinationDir)) {
        continue;
      }
      destinations.add(destinationDir);
      copies.push({ sourceDir, destinationDir });
    }
  };

  for (const source of sources) {
    addRoot(source, join(source.root, "skills"));
    const declaredSkills = isRecord(source.values.skills) ? source.values.skills : {};
    for (const path of asStringArray(declaredSkills.paths)) {
      addRoot(source, resolveDeclaredPath(dirname(source.path), path));
    }
  }
  return copies;
};

const buildContext = async (native: NativeBridge): Promise<ImportContext> => {
  const configHome = getOpenCodeConfigHome();
  const warnings: string[] = [];
  const projects = await native.listWorkspaceDirectories();
  const sources = collectConfigSources(configHome, projects, warnings);
  const mcp = collectMcpServers(sources, warnings);
  const promptData = collectPrompts(sources, configHome, warnings);
  const skills = collectSkills(sources);
  const configPaths = [
    ...configCandidates(configHome),
    join(homedir(), ".opencode", "opencode.json"),
    join(homedir(), ".opencode", "opencode.jsonc"),
  ].map((path) => ({ label: "Global configuration", path, found: existsSync(path) }));
  const preview: ExternalImportPreview = {
    sourceHome: configHome,
    sourceFound: existsSync(configHome) || existsSync(join(homedir(), ".opencode")),
    configPaths,
    instructionPaths: uniquePaths(promptData.instructionPaths).map((path) => ({
      label: "Imported instruction",
      path,
      found: true,
    })),
    projectConfigCount: sources.filter((source) => source.scope === "project").length,
    mcpServerCount: mcp.servers.filter((server) => server.scope === "global").length,
    projectMcpServerCount: mcp.servers.filter((server) => server.scope === "project").length,
    skillCount: skills.length,
    promptCount: promptData.prompts.length,
    warnings,
  };
  if (!preview.sourceFound) {
    warnings.push(`OpenCode configuration not found: ${configHome}`);
  }
  return {
    preview,
    mcpServers: mcp.servers,
    prompts: promptData.prompts,
    skills,
    globalMcpSourceFound: mcp.globalFound,
    projectMcpSourceIds: mcp.projectIds,
  };
};

export const previewOpenCodeImport = async (
  native: NativeBridge
): Promise<ExternalImportPreview> => (await buildContext(native)).preview;

export const importOpenCode = async (
  native: NativeBridge
): Promise<ExternalImportResult> => {
  const context = await buildContext(native);
  const mcpCounts = await persistImportedMcpServers(
    native,
    SOURCE,
    context.mcpServers,
    context.globalMcpSourceFound,
    context.projectMcpSourceIds
  );
  await persistImportedPrompts(native, SOURCE_PREFIX, context.prompts, context.preview.sourceFound);
  let importedSkills = 0;
  try {
    importedSkills = copySkills(context.skills);
  } catch (error) {
    context.preview.warnings.push(
      "Unable to import OpenCode Skills: " +
        (error instanceof Error ? error.message : String(error))
    );
  }
  return {
    ...context.preview,
    importedMcpServers: mcpCounts.global,
    importedProjectMcpServers: mcpCounts.project,
    importedSkills,
    importedPrompts: context.prompts.length,
  };
};
