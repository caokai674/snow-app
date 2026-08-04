import { mkdtempSync, mkdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ImportResourceRecord } from "../../shared/importResources";
import type { NativeBridge } from "../native/types";
import { buildImportDiscovery, hashImportPath, type ImportCandidateInput } from "./discovery";
import { existingManagedResourceIds } from "./unifiedDiscovery";

const temporaryPaths: string[] = [];

const temporaryDirectory = (prefix: string): string => {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryPaths.push(path);
  return path;
};

const managedResource = (
  resourceId: string,
  resourceType: ImportResourceRecord["resourceType"],
  targetId: string,
  targetPath = ""
): ImportResourceRecord => ({
  resourceId,
  resourceType,
  scope: "global",
  targetId,
  targetPath,
  management: "snapshot",
  sourceCount: 1,
  sources: [{
    sourceId: `${resourceId}:source`,
    provider: "codex",
    scope: "global",
    originPath: "/source/item",
    importedHash: "source-hash",
    currentHash: "source-hash",
    lastScannedAt: "2026-08-04T00:00:00.000Z",
  }],
  updatedAt: "2026-08-04T00:00:00.000Z",
});

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("managed import target discovery", () => {
  it("only retains tracking records whose MCP, prompt, or Skill target still exists", async () => {
    const root = temporaryDirectory("snow-import-discovery-");
    const skillPath = join(root, "skill");
    mkdirSync(skillPath);
    const resources = [
      managedResource("mcp:present", "mcp", "mcp:present"),
      managedResource("mcp:missing", "mcp", "mcp:missing"),
      managedResource("prompt:present", "prompt", "prompt:present"),
      managedResource("prompt:missing", "prompt", "prompt:missing"),
      managedResource("skill:present", "skill", skillPath, skillPath),
      managedResource("skill:missing", "skill", join(root, "missing"), join(root, "missing")),
    ];
    const native = {
      listMcpServerConfigs: async () => [{ serverId: "mcp:present" }],
      listSystemPrompts: async () => [{ promptId: "prompt:present" }],
    } as unknown as NativeBridge;

    await expect(existingManagedResourceIds(native, resources)).resolves.toEqual(new Set([
      "mcp:present",
      "prompt:present",
      "skill:present",
    ]));
  });

  it("marks a candidate with a missing tracked target as selectable repair", () => {
    const candidate: ImportCandidateInput = {
      type: "mcp",
      provider: "codex",
      scope: "global",
      originPath: "/source/item",
      logicalId: "item",
      contentHash: "source-hash",
    };
    const resource = managedResource("mcp:missing", "mcp", "mcp:missing");
    const discovery = buildImportDiscovery([
      {
        source: {
          provider: "codex",
          sourceHome: "/source",
          sourceFound: true,
          configPaths: [],
          instructionPaths: [],
          projectConfigCount: 0,
          warnings: [],
        },
        candidates: [candidate],
      },
    ], [resource], new Set());

    expect(discovery.candidates[0]?.status).toBe("repair");
  });
});

describe("import discovery worker", () => {
  it("invalidates a cached hash when a scanned file changes", async () => {
    const root = temporaryDirectory("snow-import-worker-");
    const skillPath = join(root, "skill");
    mkdirSync(skillPath);
    writeFileSync(join(skillPath, "SKILL.md"), "before", "utf8");

    const before = await hashImportPath(skillPath);
    writeFileSync(join(skillPath, "SKILL.md"), "after", "utf8");

    await expect(hashImportPath(skillPath)).resolves.not.toBe(before);
  });

  it("enforces the worker directory-depth limit", async () => {
    const root = temporaryDirectory("snow-import-worker-");
    let current = root;
    for (let index = 0; index < 21; index += 1) {
      current = join(current, `nested-${index}`);
      mkdirSync(current);
    }
    writeFileSync(join(current, "SKILL.md"), "deep", "utf8");

    await expect(hashImportPath(root)).rejects.toThrow("Import scan limit reached");
  });

  it("enforces the worker file-count limit", async () => {
    const root = temporaryDirectory("snow-import-worker-");
    for (let index = 0; index <= 5_000; index += 1) {
      writeFileSync(join(root, `file-${index}`), "", "utf8");
    }

    await expect(hashImportPath(root)).rejects.toThrow("more than 5000 files");
  });

  it("enforces the worker byte limit before reading a large file", async () => {
    const root = temporaryDirectory("snow-import-worker-");
    const largeFile = join(root, "large-skill.md");
    writeFileSync(largeFile, "", "utf8");
    truncateSync(largeFile, 64 * 1024 * 1024 + 1);

    await expect(hashImportPath(root)).rejects.toThrow("more than 67108864 bytes");
  });
});
