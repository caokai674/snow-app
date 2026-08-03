import { ipcRenderer } from "electron";
import type {
  ExternalImportPreview,
  ExternalImportResult,
} from "../types/importConfig";

export const importConfigApi = {
  previewClaudeCodeImport: (): Promise<ExternalImportPreview> =>
    ipcRenderer.invoke("import-config:preview-claude-code"),
  importClaudeCode: (): Promise<ExternalImportResult> =>
    ipcRenderer.invoke("import-config:claude-code"),
  previewOpenCodeImport: (): Promise<ExternalImportPreview> =>
    ipcRenderer.invoke("import-config:preview-opencode"),
  importOpenCode: (): Promise<ExternalImportResult> =>
    ipcRenderer.invoke("import-config:opencode"),
};
