import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileCode2,
  FolderOpen,
  Loader2,
  MessageSquareText,
  Plug,
  Puzzle,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type {
  CodexImportPreview,
  CodexImportResult,
  ExternalImportPreview,
  ExternalImportResult,
} from "../../../preload";
import { useI18n } from "../../i18n";
import { AutoDismissNotice } from "../AutoDismissNotice";

type ImportSettingsPanelProps = {
  onClose?: () => void;
};

type ImportPreview = {
  sourceHome: string;
  sourceFound: boolean;
  configPaths: Array<{ label: string; path: string; found: boolean }>;
  instructionPaths: Array<{ label: string; path: string; found: boolean }>;
  projectConfigCount: number;
  mcpServerCount: number;
  projectMcpServerCount: number;
  skillCount: number;
  promptCount: number;
  pluginCount?: number;
  pluginMcpServerCount?: number;
  warnings: string[];
};

type ImportResult = ImportPreview & {
  importedMcpServers: number;
  importedProjectMcpServers: number;
  importedSkills: number;
  importedPrompts: number;
  importedPlugins?: number;
};

type ImportSource = {
  id: "codex" | "claude-code" | "opencode";
  label: string;
  description: string;
  preview: () => Promise<ImportPreview>;
  import: () => Promise<ImportResult>;
};

type SummaryItem = {
  icon: typeof Plug;
  label: string;
  value: string;
  detail: string;
};

const toImportPreview = (preview: ExternalImportPreview): ImportPreview => preview;

const toImportResult = (result: ExternalImportResult): ImportResult => result;

const toCodexPreview = (preview: CodexImportPreview): ImportPreview => ({
  sourceHome: preview.codexHome,
  sourceFound: preview.configFound,
  configPaths: [
    {
      label: "config.toml",
      path: preview.configPath,
      found: preview.configFound,
    },
  ],
  instructionPaths: preview.globalInstructionsPath
    ? [
        {
          label: "AGENTS.md",
          path: preview.globalInstructionsPath,
          found: true,
        },
      ]
    : [],
  projectConfigCount: preview.projectConfigCount,
  mcpServerCount: preview.mcpServerCount,
  projectMcpServerCount: preview.projectMcpServerCount,
  skillCount: preview.skillCount,
  promptCount: preview.promptCount,
  pluginCount: preview.pluginCount,
  pluginMcpServerCount: preview.pluginMcpServerCount,
  warnings: preview.warnings,
});

const toCodexResult = (result: CodexImportResult): ImportResult => ({
  ...toCodexPreview(result),
  importedMcpServers: result.importedMcpServers,
  importedProjectMcpServers: result.importedProjectMcpServers,
  importedSkills: result.importedSkills,
  importedPrompts: result.importedPrompts,
  importedPlugins: result.importedPlugins,
});

function ImportSourcePanel({ source }: { source: ImportSource }): React.JSX.Element {
  const { t } = useI18n();
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [lastResult, setLastResult] = useState<ImportResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  const loadPreview = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setError("");
    try {
      setPreview(await source.preview());
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : t("settings.importPreviewError", {
              defaultValue: "Failed to inspect import configuration",
            })
      );
    } finally {
      setIsLoading(false);
    }
  }, [source, t]);

  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);

  const handleImport = async (): Promise<void> => {
    setIsImporting(true);
    setError("");
    setStatus("");
    try {
      const result = await source.import();
      setPreview(result);
      setLastResult(result);
      setStatus(
        t("settings.importSourceSuccess", {
          defaultValue: "Imported {{mcp}} MCP servers, {{skills}} Skills, and {{prompts}} prompts.",
          values: {
            mcp: result.importedMcpServers + result.importedProjectMcpServers,
            skills: result.importedSkills,
            prompts: result.importedPrompts,
          },
        })
      );
    } catch (importError) {
      setError(
        importError instanceof Error
          ? importError.message
          : t("settings.importSourceError", {
              defaultValue: "Failed to import configuration",
            })
      );
    } finally {
      setIsImporting(false);
    }
  };

  const isBusy = isLoading || isImporting;
  const summaryItems: SummaryItem[] = preview
    ? [
        {
          icon: Plug,
          label: t("settings.importMcp", { defaultValue: "MCP servers" }),
          value: String(preview.mcpServerCount + preview.projectMcpServerCount),
          detail: t("settings.importMcpScopes", {
            defaultValue: "{{global}} global / {{project}} project",
            values: {
              global: preview.mcpServerCount,
              project: preview.projectMcpServerCount,
            },
          }),
        },
        {
          icon: Sparkles,
          label: t("settings.importSkills", { defaultValue: "Skills" }),
          value: String(preview.skillCount),
          detail: t("settings.importSkillDetail", {
            defaultValue: "Copied to Snow Skills",
          }),
        },
        {
          icon: MessageSquareText,
          label: t("settings.importPrompts", { defaultValue: "Prompts" }),
          value: String(preview.promptCount),
          detail: t("settings.importPromptDetail", {
            defaultValue: "Instructions, commands, and agents",
          }),
        },
        preview.pluginCount !== undefined
          ? {
              icon: Puzzle,
              label: t("settings.importPlugins", { defaultValue: "Plugins" }),
              value: String(preview.pluginCount),
              detail: t("settings.importPluginDetail", {
                defaultValue: "{{count}} Plugin MCP servers",
                values: { count: preview.pluginMcpServerCount ?? 0 },
              }),
            }
          : {
              icon: FileCode2,
              label: t("settings.importProjectConfigs", {
                defaultValue: "Project configuration",
              }),
              value: String(preview.projectConfigCount),
              detail: t("settings.importProjectConfigDetail", {
                defaultValue: "Registered local projects",
              }),
            },
      ]
    : [];
  const instructionSummary = preview?.instructionPaths.length
    ? preview.instructionPaths.length === 1
      ? preview.instructionPaths[0].path
      : t("settings.importInstructionCount", {
          defaultValue: "{{count}} instruction files",
          values: { count: preview.instructionPaths.length },
        })
    : "-";

  return (
    <div className="import-settings-source-panel" role="tabpanel" id={`import-source-${source.id}`}>
      <div className="api-settings-actions import-settings-actions">
        <button
          className="api-settings-action-btn primary"
          onClick={() => void handleImport()}
          type="button"
          disabled={isBusy}
        >
          {isImporting ? <Loader2 size={15} className="spin" /> : <Download size={15} />}
          <span>
            {t("settings.importSource", {
              defaultValue: "Import {{source}} configuration",
              values: { source: source.label },
            })}
          </span>
        </button>
        <button
          className="api-settings-action-btn secondary"
          onClick={() => void loadPreview()}
          type="button"
          disabled={isBusy}
          aria-label={t("settings.importRefresh", { defaultValue: "Refresh preview" })}
          title={t("settings.importRefresh", { defaultValue: "Refresh preview" })}
        >
          {isLoading ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
          <span>{t("settings.importRefresh", { defaultValue: "Refresh preview" })}</span>
        </button>
      </div>

      <AutoDismissNotice
        message={error || status}
        tone={error ? "error" : "success"}
        onDismiss={() => {
          setError("");
          setStatus("");
        }}
      />

      {preview && (
        <>
          <div className="api-settings-summary-grid import-settings-summary-grid">
            {summaryItems.map(({ icon: Icon, label, value, detail }) => (
              <div className="api-settings-summary-card" key={label}>
                <Icon size={15} strokeWidth={1.8} />
                <span>{label}</span>
                <strong className="import-settings-summary-value">{value}</strong>
                <small>{detail}</small>
              </div>
            ))}
          </div>

          <section className="api-settings-form-section import-settings-source">
            <div className="api-settings-form-section-header">
              <strong className="api-settings-form-section-title">
                {t("settings.importSourceFiles", { defaultValue: "Source files" })}
              </strong>
              <span className={preview.sourceFound ? "import-settings-found" : "import-settings-missing"}>
                {preview.sourceFound ? (
                  <CheckCircle2 size={13} aria-hidden="true" />
                ) : null}
                {preview.sourceFound
                  ? t("settings.importSourceFound", { defaultValue: "Source found" })
                  : t("settings.importSourceMissing", { defaultValue: "Source not found" })}
              </span>
            </div>
            <div className="import-settings-path-list">
              <div className="import-settings-path-row">
                <FolderOpen size={14} aria-hidden="true" />
                <span>{t("settings.importSourceDirectory", { defaultValue: "Source directory" })}</span>
                <code title={preview.sourceHome}>{preview.sourceHome}</code>
              </div>
              {preview.configPaths.map((path) => (
                <div className="import-settings-path-row" key={path.path}>
                  <FileCode2 size={14} aria-hidden="true" />
                  <span>{path.label}</span>
                  <code title={path.path}>{path.path}</code>
                </div>
              ))}
              <div className="import-settings-path-row">
                <MessageSquareText size={14} aria-hidden="true" />
                <span>{t("settings.importInstructions", { defaultValue: "Instructions" })}</span>
                <code title={instructionSummary}>{instructionSummary}</code>
              </div>
            </div>
          </section>

          {preview.warnings.length > 0 && (
            <section className="api-settings-form-section import-settings-warnings">
              <strong className="api-settings-form-section-title">
                {t("settings.importWarnings", { defaultValue: "Warnings" })}
              </strong>
              <ul>
                {preview.warnings.map((warning, index) => (
                  <li key={`${warning}-${index}`}>
                    <AlertTriangle size={14} aria-hidden="true" />
                    <span>{warning}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {lastResult && (
            <section className="import-settings-result" role="status">
              <CheckCircle2 size={15} aria-hidden="true" />
              <span>
                {t("settings.importLastResult", {
                  defaultValue: "Last import: {{mcp}} MCP, {{skills}} Skills, {{prompts}} prompts",
                  values: {
                    mcp: lastResult.importedMcpServers + lastResult.importedProjectMcpServers,
                    skills: lastResult.importedSkills,
                    prompts: lastResult.importedPrompts,
                  },
                })}
              </span>
            </section>
          )}
        </>
      )}
    </div>
  );
}

export function ImportSettingsPanel({ onClose }: ImportSettingsPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const [activeSource, setActiveSource] = useState<ImportSource["id"]>("codex");
  const sources: ImportSource[] = [
    {
      id: "codex",
      label: "Codex",
      description: t("settings.importCodexDescription", {
        defaultValue: "MCP, Skills, Plugins, and prompts from Codex.",
      }),
      preview: async () => toCodexPreview(await window.snow.previewCodexImport()),
      import: async () => toCodexResult(await window.snow.importCodex()),
    },
    {
      id: "claude-code",
      label: "Claude Code",
      description: t("settings.importClaudeCodeDescription", {
        defaultValue: "MCP, Skills, CLAUDE.md, rules, and commands from Claude Code.",
      }),
      preview: async () => toImportPreview(await window.snow.previewClaudeCodeImport()),
      import: async () => toImportResult(await window.snow.importClaudeCode()),
    },
    {
      id: "opencode",
      label: "OpenCode",
      description: t("settings.importOpenCodeDescription", {
        defaultValue: "MCP, Skills, instructions, commands, and agents from OpenCode.",
      }),
      preview: async () => toImportPreview(await window.snow.previewOpenCodeImport()),
      import: async () => toImportResult(await window.snow.importOpenCode()),
    },
  ];
  const source = sources.find((item) => item.id === activeSource) ?? sources[0];

  return (
    <div className="api-settings-page import-settings-page" role="region">
      <div className="api-settings-page-header">
        <div className="api-settings-title-group">
          <strong>{t("settings.importSettings", { defaultValue: "Import configuration" })}</strong>
          <span className="settings-item-description">
            {source.description}
          </span>
        </div>
        {onClose && (
          <button
            className="icon-btn ghost"
            onClick={onClose}
            type="button"
            aria-label={t("settings.closeImportSettings", { defaultValue: "Close import settings" })}
            title={t("settings.closeImportSettings", { defaultValue: "Close import settings" })}
          >
            <X size={15} strokeWidth={1.8} />
          </button>
        )}
      </div>

      <div className="import-settings-tabs" role="tablist" aria-label={t("settings.importSettings", { defaultValue: "Import configuration" })}>
        {sources.map((item) => (
          <button
            key={item.id}
            className={`import-settings-tab ${item.id === source.id ? "active" : ""}`}
            type="button"
            role="tab"
            aria-selected={item.id === source.id}
            aria-controls={`import-source-${item.id}`}
            onClick={() => setActiveSource(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <ImportSourcePanel key={source.id} source={source} />
    </div>
  );
}
