import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { NativeBridge } from "../native/types";
import { hashImportPath } from "./discovery";
import { commitSelectedImport, type ResolvedImportAction, type SelectedImportCandidate } from "./selectedImport";

const cleanupPaths: string[] = [];

const temporaryDirectory = (prefix: string): string => {
  const path = mkdtempSync(join(tmpdir(), prefix));
  cleanupPaths.push(path);
  return path;
};

afterEach(() => {
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("commitSelectedImport", () => {
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
      contentHash: hashImportPath(source),
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
      upsertImportResources: async () => {
        throw new Error("storage unavailable");
      },
    } as unknown as NativeBridge;

    await expect(commitSelectedImport(native, [candidate], [action])).rejects.toThrow(
      "Selected import was rolled back: storage unavailable"
    );
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(join(source, "SKILL.md"), "utf8")).toBe("skill content");
  });
});
