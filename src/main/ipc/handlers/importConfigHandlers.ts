import { ipcMain } from "electron";
import type { NativeBridge } from "../../native/types";
import {
  importClaudeCode,
  previewClaudeCodeImport,
} from "../../importConfig/claudeCodeImporter";
import {
  importOpenCode,
  previewOpenCodeImport,
} from "../../importConfig/openCodeImporter";
import { discoverAllImportCandidates } from "../../importConfig/unifiedDiscovery";

export const registerImportConfigHandlers = (native: NativeBridge): void => {
  ipcMain.handle("import-config:discover", () => discoverAllImportCandidates(native));
  ipcMain.handle("import-config:preview-claude-code", () =>
    previewClaudeCodeImport(native)
  );
  ipcMain.handle("import-config:claude-code", () => importClaudeCode(native));
  ipcMain.handle("import-config:preview-opencode", () =>
    previewOpenCodeImport(native)
  );
  ipcMain.handle("import-config:opencode", () => importOpenCode(native));
};
