export type ImportConfigPath = {
  label: string;
  path: string;
  found: boolean;
};

export type ExternalImportPreview = {
  sourceHome: string;
  sourceFound: boolean;
  configPaths: ImportConfigPath[];
  instructionPaths: ImportConfigPath[];
  projectConfigCount: number;
  mcpServerCount: number;
  projectMcpServerCount: number;
  skillCount: number;
  promptCount: number;
  warnings: string[];
};

export type ExternalImportResult = ExternalImportPreview & {
  importedMcpServers: number;
  importedProjectMcpServers: number;
  importedSkills: number;
  importedPrompts: number;
};
