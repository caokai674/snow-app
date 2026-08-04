import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type {
  ImportCandidate,
  ImportCommitItemResult,
  ImportCommitResult,
  ImportScope,
} from "../../shared/importDiscovery";
import type { ImportResourceInput } from "../../shared/importResources";
import type {
  McpServerConfigInput,
  McpServerConfigRecord,
  NativeBridge,
  ProjectMcpServerConfigRecord,
  SystemPromptItemInput,
  SystemPromptItemRecord,
} from "../native/types";
import {
  hashImportPath,
  normalizeLogicalId,
  type ImportCandidateInput,
} from "./discovery";
import { prepareDirectoryCommit, type DirectoryCommit } from "./directoryCommit";

export type SelectedImportCandidate = ImportCandidate;

export type ResolvedImportAction = {
  candidate: SelectedImportCandidate;
  scope: ImportScope;
  projectId?: string;
  mcpInput?: McpServerConfigInput;
  promptInput?: SystemPromptItemInput;
  skill?: {
    sourceDir: string;
    destinationDir: string;
  };
};

const candidateMatchesInput = (
  candidate: SelectedImportCandidate,
  input: ImportCandidateInput
): boolean =>
  candidate.provider === input.provider &&
  candidate.type === input.type &&
  candidate.scope === input.scope &&
  candidate.logicalId === normalizeLogicalId(input.logicalId) &&
  candidate.contentHash === input.contentHash;

export const selectionForInput = (
  input: ImportCandidateInput,
  selected: SelectedImportCandidate[]
): SelectedImportCandidate | undefined =>
  selected.find((candidate) => candidateMatchesInput(candidate, input));

export const skillDestination = (
  provider: string,
  sourceDir: string,
  scope: ImportScope,
  projectRoot?: string
): string => {
  const skillId = basename(sourceDir)
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\.\.+/g, ".") || "imported";
  const root = scope === "project" && projectRoot
    ? join(projectRoot, ".snow", "skills")
    : join(homedir(), ".snow", "skills");
  return join(root, provider, skillId);
};

const mcpRecordToInput = (
  record: McpServerConfigRecord | ProjectMcpServerConfigRecord
): McpServerConfigInput => ({
  serverId: record.serverId,
  name: record.name,
  transportType: record.transportType,
  url: record.url,
  command: record.command,
  argsJson: record.argsJson,
  envJson: record.envJson,
  headersJson: record.headersJson,
  enabled: record.enabled,
  ...(record.timeoutMs === null ? {} : { timeoutMs: record.timeoutMs }),
  sortOrder: record.sortOrder,
  source: record.source,
});

const mcpRecordsEqual = (
  left: McpServerConfigRecord | ProjectMcpServerConfigRecord,
  right: McpServerConfigInput
): boolean =>
  left.serverId === right.serverId &&
  left.name === right.name &&
  left.transportType === right.transportType &&
  left.url === right.url &&
  left.command === right.command &&
  left.argsJson === right.argsJson &&
  left.envJson === right.envJson &&
  left.headersJson === right.headersJson &&
  left.enabled === right.enabled &&
  (left.timeoutMs ?? undefined) === right.timeoutMs &&
  left.sortOrder === right.sortOrder &&
  left.source === right.source;

const promptRecordsEqual = (
  left: SystemPromptItemRecord,
  right: SystemPromptItemInput
): boolean =>
  left.promptId === right.promptId &&
  left.name === right.name &&
  left.content === right.content &&
  left.isActive === right.isActive &&
  left.sortOrder === right.sortOrder;

type Mutation =
  | {
      kind: "global-mcp";
      serverId: string;
      previous?: McpServerConfigRecord;
    }
  | {
      kind: "project-mcp";
      projectId: string;
      serverId: string;
      previous?: ProjectMcpServerConfigRecord;
    }
  | {
      kind: "prompt";
      promptId: string;
      previous?: SystemPromptItemRecord;
    };

const rollbackMutations = async (
  native: NativeBridge,
  mutations: Mutation[]
): Promise<void> => {
  for (const mutation of [...mutations].reverse()) {
    if (mutation.kind === "global-mcp") {
      if (mutation.previous) {
        await native.upsertMcpServerConfig(mcpRecordToInput(mutation.previous));
      } else {
        await native.deleteMcpServerConfig(mutation.serverId);
      }
    } else if (mutation.kind === "project-mcp") {
      if (mutation.previous) {
        await native.upsertProjectMcpServerConfig(
          mutation.projectId,
          mcpRecordToInput(mutation.previous)
        );
      } else {
        await native.deleteProjectMcpServerConfig(
          mutation.projectId,
          mutation.serverId
        );
      }
    } else if (mutation.previous) {
      await native.upsertSystemPrompt(mutation.previous);
    } else {
      await native.deleteSystemPrompt(mutation.promptId);
    }
  }
};

const summaryFor = (results: ImportCommitItemResult[]): ImportCommitResult["summary"] => ({
  selected: results.length,
  imported: results.filter((item) => item.status === "imported").length,
  unchanged: results.filter((item) => item.status === "unchanged").length,
  alreadyEffective: results.filter((item) => item.status === "already-effective").length,
  unsupported: results.filter((item) => item.status === "unsupported").length,
  skipped: results.filter((item) => item.status === "skipped").length,
});

const resultFor = (
  action: ResolvedImportAction,
  status: ImportCommitItemResult["status"],
  message?: string
): ImportCommitItemResult => ({
  candidateId: action.candidate.candidateId,
  type: action.candidate.type,
  logicalId: action.candidate.logicalId,
  status,
  ...(message ? { message } : {}),
});

const resultForCandidate = (
  candidate: SelectedImportCandidate,
  status: ImportCommitItemResult["status"],
  message?: string
): ImportCommitItemResult => ({
  candidateId: candidate.candidateId,
  type: candidate.type,
  logicalId: candidate.logicalId,
  status,
  ...(message ? { message } : {}),
});

const resourceForAction = (action: ResolvedImportAction): ImportResourceInput | null => {
  const target = action.skill
    ? {
        targetId: action.skill.destinationDir,
        targetPath: action.skill.destinationDir,
      }
    : action.mcpInput
      ? {
          targetId: action.mcpInput.serverId,
          targetPath: "",
        }
      : action.promptInput
        ? {
            targetId: action.promptInput.promptId,
            targetPath: "",
          }
        : null;
  if (!target) {
    return null;
  }
  const projectId = action.projectId;
  const resourceId = [
    action.candidate.type,
    action.scope,
    projectId ?? "global",
    target.targetId,
  ].join(":");
  return {
    resourceId,
    resourceType: action.candidate.type,
    scope: action.scope,
    ...(projectId ? { projectId } : {}),
    targetId: target.targetId,
    targetPath: target.targetPath,
    management: "snapshot",
    sources: action.candidate.sources.map((source) => ({
      provider: source.provider,
      scope: source.scope,
      originPath: source.originPath,
      ...(source.projectId ? { projectId: source.projectId } : {}),
      contentHash: action.candidate.contentHash,
    })),
  };
};

export const commitSelectedImport = async (
  native: NativeBridge,
  candidates: SelectedImportCandidate[],
  actions: ResolvedImportAction[],
  warnings: string[] = []
): Promise<ImportCommitResult> => {
  const results = new Map<string, ImportCommitItemResult>();
  for (const candidate of candidates) {
    if (candidate.status === "already-effective") {
      results.set(candidate.candidateId, resultForCandidate(
        candidate,
        "already-effective",
        "Snow already scans this Skill path"
      ));
    } else if (candidate.status === "unsupported") {
      results.set(candidate.candidateId, resultForCandidate(
        candidate,
        "unsupported",
        candidate.unsupportedReason ?? "This resource is not supported"
      ));
    } else if (candidate.type === "plugin") {
      results.set(candidate.candidateId, resultForCandidate(
        candidate,
        "unsupported",
        "Plugin management is scheduled for Phase 4"
      ));
    }
  }

  const selectedIds = new Set(candidates.map((candidate) => candidate.candidateId));
  const actionable = actions.filter((action) =>
    selectedIds.has(action.candidate.candidateId) &&
    !results.has(action.candidate.candidateId)
  );
  const globalMcp = await native.listMcpServerConfigs();
  const projectIds = [...new Set(actionable
    .filter((action) => action.projectId && action.mcpInput)
    .map((action) => action.projectId as string))];
  const projectMcp = new Map<string, ProjectMcpServerConfigRecord[]>();
  for (const projectId of projectIds) {
    projectMcp.set(projectId, await native.listProjectMcpServerConfigs(projectId));
  }
  const prompts = await native.listSystemPrompts();
  const mutations: Mutation[] = [];
  const appliedMutations: Mutation[] = [];
  const stagedSkills: Array<{
    action: ResolvedImportAction;
    transaction: DirectoryCommit;
  }> = [];
  const committedSkills: DirectoryCommit[] = [];

  try {
    for (const action of actionable) {
      if (action.mcpInput) {
        const input = action.mcpInput;
        if (action.scope === "project" && action.projectId) {
          const existing = projectMcp.get(action.projectId)?.find((item) => item.serverId === input.serverId);
          if (existing && mcpRecordsEqual(existing, input)) {
            results.set(action.candidate.candidateId, resultFor(action, "unchanged"));
            continue;
          }
          mutations.push({ kind: "project-mcp", projectId: action.projectId, serverId: input.serverId, previous: existing });
        } else {
          const existing = globalMcp.find((item) => item.serverId === input.serverId);
          if (existing && mcpRecordsEqual(existing, input)) {
            results.set(action.candidate.candidateId, resultFor(action, "unchanged"));
            continue;
          }
          mutations.push({ kind: "global-mcp", serverId: input.serverId, previous: existing });
        }
      } else if (action.promptInput) {
        const input = action.promptInput;
        const existing = prompts.find((item) => item.promptId === input.promptId);
        if (existing && promptRecordsEqual(existing, input)) {
          results.set(action.candidate.candidateId, resultFor(action, "unchanged"));
          continue;
        }
        mutations.push({ kind: "prompt", promptId: input.promptId, previous: existing });
      } else if (action.skill) {
        if (!existsSync(action.skill.sourceDir)) {
          results.set(resultFor(action, "unsupported").candidateId, resultFor(
            action,
            "unsupported",
            "Skill source no longer exists"
          ));
          continue;
        }
        if (existsSync(action.skill.destinationDir)) {
          if (hashImportPath(action.skill.destinationDir) === action.candidate.contentHash) {
            results.set(action.candidate.candidateId, resultFor(action, "unchanged"));
          } else {
            results.set(action.candidate.candidateId, resultFor(
              action,
              "skipped",
              "Snow destination already exists with different content"
            ));
          }
          continue;
        }
        stagedSkills.push({
          action,
          transaction: prepareDirectoryCommit(
            action.skill.sourceDir,
            action.skill.destinationDir
          ),
        });
      } else {
        results.set(action.candidate.candidateId, resultFor(
          action,
          "unsupported",
          "No import handler is available for this resource"
        ));
      }
    }

    for (const mutation of mutations) {
      const action = actionable.find((item) =>
        mutation.kind === "prompt"
          ? item.promptInput?.promptId === mutation.promptId
          : mutation.kind === "global-mcp"
            ? item.mcpInput?.serverId === mutation.serverId && item.scope === "global"
            : item.mcpInput?.serverId === mutation.serverId && item.projectId === mutation.projectId
      );
      if (!action) {
        continue;
      }
      if (mutation.kind === "prompt" && action.promptInput) {
        await native.upsertSystemPrompt(action.promptInput);
      } else if (mutation.kind === "global-mcp" && action.mcpInput) {
        await native.upsertMcpServerConfig(action.mcpInput);
      } else if (mutation.kind === "project-mcp" && action.mcpInput && action.projectId) {
        await native.upsertProjectMcpServerConfig(action.projectId, action.mcpInput);
      }
      appliedMutations.push(mutation);
      results.set(action.candidate.candidateId, resultFor(action, "imported"));
    }

    for (const staged of stagedSkills) {
      staged.transaction.commit({ replaceExisting: false });
      committedSkills.push(staged.transaction);
      results.set(staged.action.candidate.candidateId, resultFor(staged.action, "imported"));
    }

    const resources = actionable
      .filter((action) => {
        const status = results.get(action.candidate.candidateId)?.status;
        return status === "imported" || status === "unchanged";
      })
      .map(resourceForAction)
      .filter((resource): resource is ImportResourceInput => Boolean(resource));
    if (resources.length > 0) {
      await native.upsertImportResources(resources);
    }
  } catch (error) {
    for (const transaction of [...committedSkills].reverse()) {
      try {
        transaction.rollback();
      } catch (rollbackError) {
        warnings.push(
          "Skill rollback was incomplete: " +
            (rollbackError instanceof Error ? rollbackError.message : String(rollbackError))
        );
      }
    }
    try {
      await rollbackMutations(native, appliedMutations);
    } catch (rollbackError) {
      warnings.push(
        "Import rollback was incomplete: " +
          (rollbackError instanceof Error ? rollbackError.message : String(rollbackError))
      );
    }
    throw new Error(
      "Selected import was rolled back: " +
        (error instanceof Error ? error.message : String(error))
    );
  } finally {
    for (const staged of stagedSkills) {
      staged.transaction.cleanup();
    }
  }

  for (const action of actionable) {
    if (!results.has(action.candidate.candidateId)) {
      results.set(action.candidate.candidateId, resultFor(
        action,
        "skipped",
        "Resource was not changed"
      ));
    }
  }

  const itemResults = candidates.map((candidate) => results.get(candidate.candidateId) ?? resultForCandidate(
    candidate,
    "unsupported",
    "Selected resource could not be resolved from the current source"
  ));
  return {
    applied: true,
    itemResults,
    summary: summaryFor(itemResults),
    warnings,
  };
};
