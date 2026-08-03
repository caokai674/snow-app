import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type {
  McpServerConfigInput,
  NativeBridge,
  SystemPromptItemInput,
} from "../native/types";
import { isRecord, toBoolean } from "../utils/value";

export type ImportScope = "global" | "project";

export type ImportedMcp = {
  scope: ImportScope;
  projectId?: string;
  input: McpServerConfigInput;
};

export type SkillCopy = {
  sourceDir: string;
  destinationDir: string;
};

export const asStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

export const asStringRecord = (value: unknown): Record<string, string> => {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(
      ([key, item]) => key.trim().length > 0 && typeof item === "string"
    )
  ) as Record<string, string>;
};

export const nonEmptyString = (value: unknown): string | null => {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
};

export const safeSegment = (value: string): string =>
  value
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\.\.+/g, ".") || "imported";

const removeJsonComments = (input: string): string => {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];
    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }
    if (char === "/" && next === "/") {
      index += 2;
      while (index < input.length && input[index] !== "\n") {
        index += 1;
      }
      if (index < input.length) {
        result += "\n";
      }
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (
        index < input.length &&
        !(input[index] === "*" && input[index + 1] === "/")
      ) {
        if (input[index] === "\n") {
          result += "\n";
        }
        index += 1;
      }
      index += 1;
      continue;
    }
    result += char;
  }
  return result;
};

const removeTrailingCommas = (input: string): string => {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }
    if (char === ",") {
      let cursor = index + 1;
      while (/\s/.test(input[cursor] ?? "")) {
        cursor += 1;
      }
      if (input[cursor] === "}" || input[cursor] === "]") {
        continue;
      }
    }
    result += char;
  }
  return result;
};

export const readJson = (
  filePath: string,
  warnings: string[],
  allowComments = false
): Record<string, unknown> | null => {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const text = readFileSync(filePath, "utf8");
    const parsed: unknown = JSON.parse(
      allowComments ? removeTrailingCommas(removeJsonComments(text)) : text
    );
    if (isRecord(parsed)) {
      return parsed;
    }
    warnings.push("Ignoring non-object configuration file: " + filePath);
    return null;
  } catch (error) {
    warnings.push(
      "Unable to parse " +
        filePath +
        ": " +
        (error instanceof Error ? error.message : String(error))
    );
    return null;
  }
};

export const readText = (
  filePath: string,
  warnings: string[]
): string | null => {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const content = readFileSync(filePath, "utf8").trim();
    return content || null;
  } catch (error) {
    warnings.push(
      "Unable to read " +
        filePath +
        ": " +
        (error instanceof Error ? error.message : String(error))
    );
    return null;
  }
};

export const walkFiles = (
  root: string,
  predicate: (filePath: string) => boolean,
  maxDepth = 10
): string[] => {
  if (!existsSync(root)) {
    return [];
  }

  const matches: string[] = [];
  const visit = (current: string, depth: number): void => {
    if (depth > maxDepth) {
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

export const collectSkillDirectories = (root: string): string[] =>
  walkFiles(root, (filePath) => filePath.endsWith(`${sep}SKILL.md`)).map(dirname);

export const copySkills = (skills: SkillCopy[]): number => {
  let copied = 0;
  for (const skill of skills) {
    mkdirSync(dirname(skill.destinationDir), { recursive: true });
    cpSync(skill.sourceDir, skill.destinationDir, { recursive: true, force: true });
    copied += 1;
  }
  return copied;
};

export const createPrompt = (
  promptId: string,
  name: string,
  content: string,
  sortOrder: number
): SystemPromptItemInput | null => {
  const trimmed = content.trim();
  return trimmed
    ? { promptId, name, content: trimmed, isActive: true, sortOrder }
    : null;
};

export const createMcpInput = (input: {
  serverId: string;
  name: string;
  source: string;
  sortOrder: number;
  transportType: "http" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  enabled?: unknown;
  timeoutMs?: number;
}): McpServerConfigInput | null => {
  const url = input.url?.trim() ?? "";
  const command = input.command?.trim() ?? "";
  if ((input.transportType === "http" && !url) || (input.transportType === "stdio" && !command)) {
    return null;
  }
  return {
    serverId: input.serverId,
    name: input.name,
    transportType: input.transportType,
    url,
    command,
    argsJson: JSON.stringify(input.args ?? []),
    envJson: JSON.stringify(input.env ?? {}),
    headersJson: JSON.stringify(input.headers ?? {}),
    enabled: toBoolean(input.enabled, true),
    ...(input.timeoutMs && input.timeoutMs > 0
      ? { timeoutMs: Math.round(input.timeoutMs) }
      : {}),
    sortOrder: input.sortOrder,
    source: input.source,
  };
};

export const persistImportedMcpServers = async (
  native: NativeBridge,
  source: string,
  servers: ImportedMcp[],
  globalSourceFound: boolean,
  projectSourceIds: Set<string>
): Promise<{ global: number; project: number }> => {
  const globalServers = servers.filter((server) => server.scope === "global");
  const projectServers = servers.filter(
    (server) => server.scope === "project" && server.projectId
  );

  for (const server of globalServers) {
    await native.upsertMcpServerConfig(server.input);
  }
  if (globalSourceFound) {
    const nextIds = new Set(globalServers.map((server) => server.input.serverId));
    const existing = await native.listMcpServerConfigs();
    for (const server of existing) {
      if (server.source === source && !nextIds.has(server.serverId)) {
        await native.deleteMcpServerConfig(server.serverId);
      }
    }
  }

  for (const projectId of projectSourceIds) {
    const scoped = projectServers.filter((server) => server.projectId === projectId);
    for (const server of scoped) {
      await native.upsertProjectMcpServerConfig(projectId, server.input);
    }
    const nextIds = new Set(scoped.map((server) => server.input.serverId));
    const existing = await native.listProjectMcpServerConfigs(projectId);
    for (const server of existing) {
      if (server.source === source && !nextIds.has(server.serverId)) {
        await native.deleteProjectMcpServerConfig(projectId, server.serverId);
      }
    }
  }

  return { global: globalServers.length, project: projectServers.length };
};

export const persistImportedPrompts = async (
  native: NativeBridge,
  sourcePrefix: string,
  prompts: SystemPromptItemInput[],
  sourceFound: boolean
): Promise<void> => {
  if (!sourceFound) {
    return;
  }
  const nextIds = new Set(prompts.map((prompt) => prompt.promptId));
  const existing = await native.listSystemPrompts();
  for (const prompt of existing) {
    if (prompt.promptId.startsWith(sourcePrefix) && !nextIds.has(prompt.promptId)) {
      await native.deleteSystemPrompt(prompt.promptId);
    }
  }
  for (const prompt of prompts) {
    await native.upsertSystemPrompt(prompt);
  }
};

export const projectPathMatches = (path: string, candidate: string): boolean =>
  path === candidate || path.startsWith(`${candidate}${sep}`);

export const uniquePaths = (paths: string[]): string[] =>
  [...new Set(paths.map((path) => path.trim()).filter(Boolean))];

export const destinationForSkill = (
  sourceRoot: string,
  sourceDir: string,
  destinationRoot: string
): string => {
  const path = relative(sourceRoot, sourceDir);
  return path ? join(destinationRoot, path) : destinationRoot;
};
