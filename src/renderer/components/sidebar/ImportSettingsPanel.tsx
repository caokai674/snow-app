import {
  AlertTriangle,
  CheckCircle2,
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
  ImportCandidate,
  ImportDiscovery,
  ImportProvider,
  ImportSource as DiscoveredImportSource,
} from "../../../preload";
import { useI18n } from "../../i18n";
import { AutoDismissNotice } from "../AutoDismissNotice";

type ImportSettingsPanelProps = {
  onClose?: () => void;
};

type ImportPreview = {
  source: DiscoveredImportSource;
  candidates: ImportCandidate[];
  mcpServerCount: number;
  projectMcpServerCount: number;
  skillCount: number;
  promptCount: number;
  pluginCount: number;
  pluginMcpServerCount: number;
};

type ImportSource = {
  id: ImportProvider;
  label: string;
  description: string;
  preview: () => Promise<ImportPreview>;
};

type SummaryItem = {
  icon: typeof Plug;
  label: string;
  value: string;
  detail: string;
};

const toImportPreview = (discovery: ImportDiscovery, provider: ImportProvider): ImportPreview => {
  const source = discovery.sources.find((item) => item.provider === provider);
  if (!source) {
    throw new Error(`Import source not found: ${provider}`);
  }
  const candidates = discovery.candidates.filter((candidate) =>
    candidate.sources.some((origin) => origin.provider === provider)
  );
  return {
    source,
    candidates,
    mcpServerCount: candidates.filter((candidate) => candidate.type === "mcp" && candidate.scope === "global").length,
    projectMcpServerCount: candidates.filter((candidate) => candidate.type === "mcp" && candidate.scope === "project").length,
    skillCount: candidates.filter((candidate) => candidate.type === "skill").length,
    promptCount: candidates.filter((candidate) =>
      candidate.type === "prompt" || candidate.type === "command" || candidate.type === "agent"
    ).length,
    pluginCount: candidates.filter((candidate) => candidate.type === "plugin").length,
    pluginMcpServerCount: candidates.filter((candidate) =>
      candidate.type === "mcp" && candidate.sources.some((origin) => origin.provider === "codex")
    ).length,
  };
};

function ImportSourcePanel({ source }: { source: ImportSource }): React.JSX.Element {
  const { t } = useI18n();
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [isLoading, setIsLoading] = useState(false);
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

  const isBusy = isLoading;
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
            defaultValue: "Read-only candidates",
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
        preview.pluginCount > 0
          ? {
              icon: Puzzle,
              label: t("settings.importPlugins", { defaultValue: "Plugins" }),
              value: String(preview.pluginCount),
              detail: t("settings.importPluginDetail", {
                defaultValue: "{{count}} Plugin MCP servers",
                values: { count: preview.pluginMcpServerCount },
              }),
            }
          : {
              icon: FileCode2,
              label: t("settings.importProjectConfigs", {
                defaultValue: "Project configuration",
              }),
              value: String(preview.source.projectConfigCount),
              detail: t("settings.importProjectConfigDetail", {
                defaultValue: "Registered local projects",
              }),
            },
      ]
    : [];
  const instructionSummary = preview?.source.instructionPaths.length
    ? preview.source.instructionPaths.length === 1
      ? preview.source.instructionPaths[0].path
      : t("settings.importInstructionCount", {
          defaultValue: "{{count}} instruction files",
          values: { count: preview.source.instructionPaths.length },
        })
    : "-";

  return (
    <div className="import-settings-source-panel" role="tabpanel" id={`import-source-${source.id}`}>
      <div className="api-settings-actions import-settings-actions">
        <button
          className="api-settings-action-btn primary"
          onClick={() => void loadPreview()}
          type="button"
          disabled={isBusy}
        >
          {isLoading ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
          <span>
            {t("settings.importRefresh", { defaultValue: "Refresh discovery" })}
          </span>
        </button>
      </div>

      <AutoDismissNotice
        message={error}
        tone="error"
        onDismiss={() => {
          setError("");
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
              <span className={preview.source.sourceFound ? "import-settings-found" : "import-settings-missing"}>
                {preview.source.sourceFound ? (
                  <CheckCircle2 size={13} aria-hidden="true" />
                ) : null}
                {preview.source.sourceFound
                  ? t("settings.importSourceFound", { defaultValue: "Source found" })
                  : t("settings.importSourceMissing", { defaultValue: "Source not found" })}
              </span>
            </div>
            <div className="import-settings-path-list">
              <div className="import-settings-path-row">
                <FolderOpen size={14} aria-hidden="true" />
                <span>{t("settings.importSourceDirectory", { defaultValue: "Source directory" })}</span>
                <code title={preview.source.sourceHome}>{preview.source.sourceHome}</code>
              </div>
              {preview.source.configPaths.map((path) => (
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

          {preview.source.warnings.length > 0 && (
            <section className="api-settings-form-section import-settings-warnings">
              <strong className="api-settings-form-section-title">
                {t("settings.importWarnings", { defaultValue: "Warnings" })}
              </strong>
              <ul>
                {preview.source.warnings.map((warning, index) => (
                  <li key={`${warning}-${index}`}>
                    <AlertTriangle size={14} aria-hidden="true" />
                    <span>{warning}</span>
                  </li>
                ))}
              </ul>
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
      preview: async () => toImportPreview(await window.snow.discoverImportCandidates(), "codex"),
    },
    {
      id: "claude-code",
      label: "Claude Code",
      description: t("settings.importClaudeCodeDescription", {
        defaultValue: "MCP, Skills, CLAUDE.md, rules, and commands from Claude Code.",
      }),
      preview: async () => toImportPreview(await window.snow.discoverImportCandidates(), "claude-code"),
    },
    {
      id: "opencode",
      label: "OpenCode",
      description: t("settings.importOpenCodeDescription", {
        defaultValue: "MCP, Skills, instructions, commands, and agents from OpenCode.",
      }),
      preview: async () => toImportPreview(await window.snow.discoverImportCandidates(), "opencode"),
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
