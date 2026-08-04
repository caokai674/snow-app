import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { NativeBridge } from "../native/types";
import type { PluginImportDefinition } from "./pluginManager";
import { commitPluginImports } from "./pluginManager";

const cleanupPaths: string[] = [];

const temporaryDirectory = (prefix: string): string => {
  const path = mkdtempSync(join(tmpdir(), prefix));
  cleanupPaths.push(path);
  return path;
};

const writeSkill = (directory: string, content: string): void => {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "SKILL.md"), content, "utf8");
};

afterEach(() => {
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("commitPluginImports", () => {
  it("restores an overwritten Plugin Skill when a later component fails", async () => {
    const root = temporaryDirectory("snow-plugin-import-");
    const source = join(root, "source");
    const target = join(root, "managed", "skill");
    writeSkill(source, "new skill");
    writeSkill(target, "old skill");
    const definition: PluginImportDefinition = {
      candidate: {
        type: "plugin",
        provider: "codex",
        scope: "global",
        originPath: source,
        logicalId: "plugin-test",
        contentHash: "plugin-hash",
      },
      input: {
        pluginId: "plugin:test",
        name: "Plugin test",
        version: "1.0.0",
        provider: "codex",
        sourcePath: source,
        manifestPath: join(source, "plugin.json"),
        scope: "global",
        state: "enabled",
        capabilities: [],
        contentHash: "plugin-hash",
        components: [{
          componentId: "skill:test",
          componentType: "skill",
          logicalId: "test",
          targetId: "test",
          targetPath: target,
          originPath: source,
          contentHash: "skill-hash",
          status: "supported",
          sortOrder: 0,
        }],
      },
      runtime: [{
        component: {
          componentId: "skill:test",
          componentType: "skill",
          logicalId: "test",
          targetId: "test",
          targetPath: target,
          originPath: source,
          contentHash: "skill-hash",
          status: "supported",
          sortOrder: 0,
        },
        skillSourceDir: source,
      }],
    };
    const native = {
      listMcpServerConfigs: async () => [],
      listSystemPrompts: async () => [],
      setSkillEnabled: async () => {
        throw new Error("Skill settings unavailable");
      },
    } as unknown as NativeBridge;

    const result = await commitPluginImports(native, [definition]);
    expect(result.itemResults).toEqual([expect.objectContaining({ status: "skipped" })]);
    expect(result.warnings.at(-1)).toContain("Skill settings unavailable");
    expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("old skill");
  });
});
