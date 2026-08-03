import type { NativeBridge } from "../native/types";
import type { ImportDiscovery } from "../../shared/importDiscovery";
import { discoverCodexImport } from "../codex/importer";
import { discoverClaudeCodeImport } from "./claudeCodeImporter";
import { buildImportDiscovery } from "./discovery";
import { discoverOpenCodeImport } from "./openCodeImporter";

export const discoverAllImportCandidates = async (
  native: NativeBridge
): Promise<ImportDiscovery> =>
  buildImportDiscovery(await Promise.all([
    discoverCodexImport(native),
    discoverClaudeCodeImport(native),
    discoverOpenCodeImport(native),
  ]));
