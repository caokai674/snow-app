import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ImportResourceInput } from "../../shared/importResources";
import type { NativeBridge } from "../native/types";
import { ensureLegacyImportResourceMigration } from "./legacyImportMigration";

const originalHome = process.env.HOME;
const originalCodexHome = process.env.CODEX_HOME;
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
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
});

describe("legacy import resource migration", () => {
  it("tracks a migrated Skill against its discovered Codex source", async () => {
    const home = temporaryDirectory("snow-legacy-home-");
    const codexHome = temporaryDirectory("snow-legacy-codex-");
    process.env.HOME = home;
    process.env.CODEX_HOME = codexHome;
    const externalSkill = join(codexHome, "skills", "review");
    const legacySnapshot = join(home, ".snow", "skills", "codex", "review");
    mkdirSync(externalSkill, { recursive: true });
    mkdirSync(legacySnapshot, { recursive: true });
    writeFileSync(join(externalSkill, "SKILL.md"), "external source", "utf8");
    writeFileSync(join(legacySnapshot, "SKILL.md"), "legacy copy", "utf8");

    const stored: ImportResourceInput[] = [];
    const native = {
      getSystemSettingValue: async () => undefined,
      listWorkspaceDirectories: async () => [],
      listImportResources: async () => [],
      releaseImportResource: async () => ({ action: "deleted" }),
      upsertImportResources: async (resources: ImportResourceInput[]) => stored.push(...resources),
      setSystemSetting: async () => {},
    } as unknown as NativeBridge;

    await ensureLegacyImportResourceMigration(native);

    expect(stored).toHaveLength(1);
    expect(stored[0]?.sources).toEqual([expect.objectContaining({
      provider: "codex",
      originPath: externalSkill,
    })]);
    expect(stored[0]?.sources.some((source) => source.provider === "snow")).toBe(false);
  });
});
