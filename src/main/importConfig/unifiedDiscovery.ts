import type { NativeBridge } from "../native/types";
import type { ImportDiscovery } from "../../shared/importDiscovery";
import { discoverCodexImport } from "../codex/importer";
import { discoverClaudeCodeImport } from "./claudeCodeImporter";
import { buildImportDiscovery } from "./discovery";
import { discoverOpenCodeImport } from "./openCodeImporter";
import { discoverPluginImports } from "./pluginManager";

export const discoverAllImportCandidates = async (
  native: NativeBridge
): Promise<ImportDiscovery> => {
  const [discoveries, managedResources, pluginDefinitions, managedPlugins] = await Promise.all([
    Promise.all([
      discoverCodexImport(native),
      discoverClaudeCodeImport(native),
      discoverOpenCodeImport(native),
    ]),
    native.listImportResources(),
    discoverPluginImports(native),
    native.listPlugins(),
  ]);
  for (const definition of pluginDefinitions) {
    const source = discoveries.find((item) => item.source.provider === definition.input.provider);
    if (source) source.candidates.push(definition.candidate);
  }
  const discovery = buildImportDiscovery(discoveries, managedResources);
  for (const candidate of discovery.candidates.filter((item) => item.type === "plugin")) {
    const managed = managedPlugins.find((item) => item.pluginId === candidate.logicalId);
    if (!managed) continue;
    candidate.status = managed.contentHash === candidate.contentHash ? "managed" : "update-available";
    candidate.ownership = { owner: "snow", management: "snapshot" };
  }
  return discovery;
};
