import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ImportResourceInput } from "../../shared/importResources";
import type { NativeBridge, WorkspaceDirectoryRecord } from "../native/types";
import { hashImportPath } from "./discovery";

const MIGRATION_SETTING = "import-resource-migration-v1";
const LEGACY_PROVIDERS = ["codex", "claude-code", "opencode"] as const;

const collectSkillSnapshots = (
  root: string,
  scope: "global" | "project",
  projectId?: string
): ImportResourceInput[] => {
  const resources: ImportResourceInput[] = [];
  for (const provider of LEGACY_PROVIDERS) {
    const providerRoot = join(root, provider);
    if (!existsSync(providerRoot)) {
      continue;
    }
    for (const entry of readdirSync(providerRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const targetPath = join(providerRoot, entry.name);
      try {
        const contentHash = hashImportPath(targetPath);
        resources.push({
          resourceId: ["skill", scope, projectId ?? "global", targetPath].join(":"),
          resourceType: "skill",
          scope,
          ...(projectId ? { projectId } : {}),
          targetId: targetPath,
          targetPath,
          management: "snapshot",
          sources: [{
            provider: "snow",
            scope,
            originPath: targetPath,
            ...(projectId ? { projectId } : {}),
            contentHash,
          }],
        });
      } catch {
        // Leave unreadable legacy copies untouched; a later import can register them safely.
      }
    }
  }
  return resources;
};

const projectSkillSnapshots = (projects: WorkspaceDirectoryRecord[]): ImportResourceInput[] =>
  projects
    .filter((project) => project.kind === "local")
    .flatMap((project) =>
      collectSkillSnapshots(join(project.path, ".snow", "skills"), "project", project.directoryId)
    );

export const ensureLegacyImportResourceMigration = async (native: NativeBridge): Promise<void> => {
  if (await native.getSystemSettingValue(MIGRATION_SETTING)) {
    return;
  }
  const projects = await native.listWorkspaceDirectories();
  const resources = [
    ...collectSkillSnapshots(join(homedir(), ".snow", "skills"), "global"),
    ...projectSkillSnapshots(projects),
  ];
  if (resources.length > 0) {
    await native.upsertImportResources(resources);
  }
  await native.setSystemSetting(
    "Import resource migration version",
    MIGRATION_SETTING,
    "1"
  );
};
