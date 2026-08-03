import { ipcRenderer } from "electron";
import type {
  ExternalImportPreview,
  ExternalImportResult,
  ImportDiscovery,
} from "../types/importConfig";

export const importConfigApi = {
  discoverImportCandidates: (): Promise<ImportDiscovery> =>
    ipcRenderer.invoke("import-config:discover"),
  previewClaudeCodeImport: (): Promise<ExternalImportPreview> =>
    ipcRenderer.invoke("import-config:preview-claude-code"),
  importClaudeCode: (): Promise<ExternalImportResult> =>
    ipcRenderer.invoke("import-config:claude-code"),
  previewOpenCodeImport: (): Promise<ExternalImportPreview> =>
    ipcRenderer.invoke("import-config:preview-opencode"),
  importOpenCode: (): Promise<ExternalImportResult> =>
    ipcRenderer.invoke("import-config:opencode"),
};
