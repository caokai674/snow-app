import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ImportResourceRecord } from "../../shared/importResources";
import type { NativeBridge } from "../native/types";
import {
  buildImportDiscovery,
  hashImportPath,
  type ImportCandidateInput,
} from "./discovery";
import {
  commitSelectedImport,
  selectionForInput,
  type ResolvedImportAction,
  type SelectedImportCandidate,
} from "./selectedImport";

const cleanupPaths: string[] = [];

const temporaryDirectory = (prefix: string): string => {
  const path = mkdtempSync(join(tmpdir(), prefix));
  cleanupPaths.push(path);
  return path;
};

const skillCandidate = (
  source: string,
  contentHash: string,
  status: SelectedImportCandidate["status"] = "new"
): SelectedImportCandidate => ({
  candidateId: "skill:update",
  type: "skill",
  provider: "codex",
  scope: "global",
  originPath: source,
  logicalId: "update",
  contentHash,
  status,
  ownership: { owner: "snow", management: "snapshot" },
  sources: [{ provider: "codex", scope: "global", originPath: source }],
});

const managedSkillSnapshot = (
  source: string,
  target: string,
  importedHash: string,
  management: ImportResourceRecord["management"] = "snapshot"
): ImportResourceRecord => ({
  resourceId: `skill:global:global:${target}`,
  resourceType: "skill",
  scope: "global",
  targetId: target,
  targetPath: target,
  management,
  sourceCount: 1,
  sources: [{
    sourceId: "import-source:update",
    provider: "codex",
    scope: "global",
    originPath: source,
    importedHash,
    currentHash: importedHash,
    lastScannedAt: "2026-08-04T00:00:00.000Z",
  }],
  updatedAt: "2026-08-04T00:00:00.000Z",
});

afterEach(() => {
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("commitSelectedImport", () => {
  it("keeps identical content separate unless it maps to the same import target", () => {
    const root = temporaryDirectory("snow-import-target-");
    const globalCodex: ImportCandidateInput = {
      type: "skill",
      provider: "codex",
      scope: "global",
      originPath: join(root, "codex-global"),
      logicalId: "shared-skill",
      contentHash: "same-content",
    };
    const projectOne: ImportCandidateInput = {
      ...globalCodex,
      scope: "project",
      originPath: join(root, "project-one"),
      projectId: "project-one",
    };
    const projectTwo: ImportCandidateInput = {
      ...projectOne,
      originPath: join(root, "project-two"),
      projectId: "project-two",
    };
    const claudeGlobal: ImportCandidateInput = {
      ...globalCodex,
      provider: "claude-code",
      originPath: join(root, "claude-global"),
    };
    const discovery = buildImportDiscovery([
      {
        source: {
          provider: "codex",
          sourceHome: join(root, "codex"),
          sourceFound: true,
          configPaths: [],
          instructionPaths: [],
          projectConfigCount: 2,
          warnings: [],
        },
        candidates: [
          globalCodex,
          { ...globalCodex, originPath: join(root, "codex-global-copy") },
          projectOne,
          projectTwo,
        ],
      },
      {
        source: {
          provider: "claude-code",
          sourceHome: join(root, "claude"),
          sourceFound: true,
          configPaths: [],
          instructionPaths: [],
          projectConfigCount: 0,
          warnings: [],
        },
        candidates: [claudeGlobal],
      },
    ]);

    expect(discovery.candidates).toHaveLength(4);
    expect(discovery.candidates.find((candidate) =>
      candidate.provider === "codex" && candidate.scope === "global"
    )?.sources).toHaveLength(2);
    expect(selectionForInput(projectTwo, discovery.candidates)).toMatchObject({
      provider: "codex",
      scope: "project",
      projectId: "project-two",
      logicalId: "shared-skill",
    });
  });

  it("rolls back a committed Skill when resource registration fails", async () => {
    const root = temporaryDirectory("snow-selected-import-");
    const source = join(root, "source");
    const target = join(root, "managed", "skill");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "SKILL.md"), "skill content", "utf8");
    const candidate: SelectedImportCandidate = {
      candidateId: "skill:rollback",
      type: "skill",
      provider: "codex",
      scope: "global",
      originPath: source,
      logicalId: "rollback",
      contentHash: await hashImportPath(source),
      status: "new",
      ownership: { owner: "external", management: "reference" },
      sources: [{ provider: "codex", scope: "global", originPath: source }],
    };
    const action: ResolvedImportAction = {
      candidate,
      scope: "global",
      skill: { sourceDir: source, destinationDir: target },
    };
    const native = {
      listMcpServerConfigs: async () => [],
      listSystemPrompts: async () => [],
      listImportResources: async () => [],
      commitImportTransaction: async () => {
        throw new Error("storage unavailable");
      },
    } as unknown as NativeBridge;

    await expect(commitSelectedImport(native, [candidate], [action])).rejects.toThrow(
      "Selected import was rolled back: storage unavailable"
    );
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(join(source, "SKILL.md"), "utf8")).toBe("skill content");
  });

  it("replaces an unmodified managed Skill snapshot when its external source updates", async () => {
    const root = temporaryDirectory("snow-selected-import-");
    const source = join(root, "source");
    const target = join(root, "managed", "skill");
    mkdirSync(source, { recursive: true });
    mkdirSync(target, { recursive: true });
    writeFileSync(join(source, "SKILL.md"), "updated skill", "utf8");
    writeFileSync(join(target, "SKILL.md"), "previous skill", "utf8");
    const previousHash = await hashImportPath(target);
    const candidate = skillCandidate(source, await hashImportPath(source), "update-available");
    const action: ResolvedImportAction = {
      candidate,
      scope: "global",
      skill: { sourceDir: source, destinationDir: target },
    };
    const upsertedResources: unknown[] = [];
    const native = {
      listMcpServerConfigs: async () => [],
      listSystemPrompts: async () => [],
      listImportResources: async () => [managedSkillSnapshot(source, target, previousHash)],
      commitImportTransaction: async (transaction: { importResources: unknown[] }) => {
        upsertedResources.push(...transaction.importResources);
      },
    } as unknown as NativeBridge;

    const result = await commitSelectedImport(native, [candidate], [action]);

    expect(result.summary).toMatchObject({ imported: 1, skipped: 0 });
    expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("updated skill");
    expect(upsertedResources).toHaveLength(1);
  });

  it("preserves a managed Skill snapshot with local modifications", async () => {
    const root = temporaryDirectory("snow-selected-import-");
    const source = join(root, "source");
    const target = join(root, "managed", "skill");
    mkdirSync(source, { recursive: true });
    mkdirSync(target, { recursive: true });
    writeFileSync(join(source, "SKILL.md"), "updated skill", "utf8");
    writeFileSync(join(target, "SKILL.md"), "previous skill", "utf8");
    const importedHash = await hashImportPath(target);
    writeFileSync(join(target, "SKILL.md"), "local modification", "utf8");
    const candidate = skillCandidate(source, await hashImportPath(source), "update-available");
    const action: ResolvedImportAction = {
      candidate,
      scope: "global",
      skill: { sourceDir: source, destinationDir: target },
    };
    const native = {
      listMcpServerConfigs: async () => [],
      listSystemPrompts: async () => [],
      listImportResources: async () => [managedSkillSnapshot(source, target, importedHash)],
    } as unknown as NativeBridge;

    const result = await commitSelectedImport(native, [candidate], [action]);

    expect(result.summary).toMatchObject({ imported: 0, skipped: 1 });
    expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("local modification");
  });

  it("does not replace a non-snapshot Skill destination", async () => {
    const root = temporaryDirectory("snow-selected-import-");
    const source = join(root, "source");
    const target = join(root, "managed", "skill");
    mkdirSync(source, { recursive: true });
    mkdirSync(target, { recursive: true });
    writeFileSync(join(source, "SKILL.md"), "updated skill", "utf8");
    writeFileSync(join(target, "SKILL.md"), "previous skill", "utf8");
    const previousHash = await hashImportPath(target);
    const candidate = skillCandidate(source, await hashImportPath(source), "update-available");
    const action: ResolvedImportAction = {
      candidate,
      scope: "global",
      skill: { sourceDir: source, destinationDir: target },
    };
    const native = {
      listMcpServerConfigs: async () => [],
      listSystemPrompts: async () => [],
      listImportResources: async () => [managedSkillSnapshot(source, target, previousHash, "reference")],
    } as unknown as NativeBridge;

    const result = await commitSelectedImport(native, [candidate], [action]);

    expect(result.summary).toMatchObject({ imported: 0, skipped: 1 });
    expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("previous skill");
  });

  it("restores a replaced Skill snapshot when resource registration fails", async () => {
    const root = temporaryDirectory("snow-selected-import-");
    const source = join(root, "source");
    const target = join(root, "managed", "skill");
    mkdirSync(source, { recursive: true });
    mkdirSync(target, { recursive: true });
    writeFileSync(join(source, "SKILL.md"), "updated skill", "utf8");
    writeFileSync(join(target, "SKILL.md"), "previous skill", "utf8");
    const previousHash = await hashImportPath(target);
    const candidate = skillCandidate(source, await hashImportPath(source), "update-available");
    const action: ResolvedImportAction = {
      candidate,
      scope: "global",
      skill: { sourceDir: source, destinationDir: target },
    };
    const native = {
      listMcpServerConfigs: async () => [],
      listSystemPrompts: async () => [],
      listImportResources: async () => [managedSkillSnapshot(source, target, previousHash)],
      commitImportTransaction: async () => {
        throw new Error("storage unavailable");
      },
    } as unknown as NativeBridge;

    await expect(commitSelectedImport(native, [candidate], [action])).rejects.toThrow(
      "Selected import was rolled back: storage unavailable"
    );
    expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("previous skill");
  });
});
