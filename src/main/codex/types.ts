export type CodexImportPreview = {
  codexHome: string;
  configPath: string;
  configFound: boolean;
  globalInstructionsPath: string | null;
  projectConfigCount: number;
  mcpServerCount: number;
  projectMcpServerCount: number;
  skillCount: number;
  pluginCount: number;
  pluginSkillCount: number;
  pluginMcpServerCount: number;
  promptCount: number;
  warnings: string[];
};

export type CodexImportResult = CodexImportPreview & {
  importedMcpServers: number;
  importedProjectMcpServers: number;
  importedSkills: number;
  importedPlugins: number;
  importedPrompts: number;
};
