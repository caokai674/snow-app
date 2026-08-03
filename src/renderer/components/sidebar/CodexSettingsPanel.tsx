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
import type { CodexImportPreview, CodexImportResult } from "../../../preload";
import { useI18n } from "../../i18n";
import { AutoDismissNotice } from "../AutoDismissNotice";

type CodexSettingsPanelProps = {
  onClose?: () => void;
};

type SummaryItem = {
  icon: typeof Plug;
  label: string;
  value: string;
  detail?: string;
};

const formatPath = (value: string | null): string => value ?? "-";

export function CodexSettingsPanel({
  onClose,
}: CodexSettingsPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const [preview, setPreview] = useState<CodexImportPreview | null>(null);
  const [lastResult, setLastResult] = useState<CodexImportResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  const loadPreview = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setError("");
    try {
      setPreview(await window.snow.previewCodexImport());
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : t("settings.codexImportPreviewError", {
              defaultValue: "Failed to inspect Codex configuration",
            })
      );
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);

  const handleImport = async (): Promise<void> => {
    setIsImporting(true);
    setError("");
    setStatus("");
    try {
      const result = await window.snow.importCodex();
      setPreview(result);
      setLastResult(result);
      setStatus(
        t("settings.codexImportSuccess", {
          defaultValue:
            "Imported {{mcp}} MCP servers, {{skills}} Skills, {{plugins}} Plugins, and {{prompts}} prompts.",
          values: {
            mcp: result.importedMcpServers + result.importedProjectMcpServers,
            skills: result.importedSkills,
            plugins: result.importedPlugins,
            prompts: result.importedPrompts,
          },
        })
      );
    } catch (importError) {
      setError(
        importError instanceof Error
          ? importError.message
          : t("settings.codexImportError", {
              defaultValue: "Failed to import Codex configuration",
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
          label: t("settings.codexMcp", { defaultValue: "MCP servers" }),
          value: String(preview.mcpServerCount + preview.projectMcpServerCount),
          detail: t("settings.codexMcpScopes", {
            defaultValue: "{{global}} global / {{project}} project",
            values: {
              global: preview.mcpServerCount,
              project: preview.projectMcpServerCount,
            },
          }),
        },
        {
          icon: Sparkles,
          label: t("settings.codexSkills", { defaultValue: "Skills" }),
          value: String(preview.skillCount),
          detail: t("settings.codexPluginSkills", {
            defaultValue: "{{count}} from Plugins",
            values: { count: preview.pluginSkillCount },
          }),
        },
        {
          icon: Puzzle,
          label: t("settings.codexPlugins", { defaultValue: "Plugins" }),
          value: String(preview.pluginCount),
          detail: t("settings.codexPluginMcp", {
            defaultValue: "{{count}} Plugin MCP servers",
            values: { count: preview.pluginMcpServerCount },
          }),
        },
        {
          icon: MessageSquareText,
          label: t("settings.codexPrompts", { defaultValue: "Prompts" }),
          value: String(preview.promptCount),
          detail: t("settings.codexProjectConfigs", {
            defaultValue: "{{count}} project configs",
            values: { count: preview.projectConfigCount },
          }),
        },
      ]
    : [];

  return (
    <div className="api-settings-page codex-settings-page" role="region">
      <div className="api-settings-page-header">
        <div className="api-settings-title-group">
          <strong>
            {t("settings.codexTitle", { defaultValue: "Codex compatibility" })}
          </strong>
          <span className="settings-item-description">
            {t("settings.codexSettingsInfo", {
              defaultValue: "Import Codex MCP, Skills, Plugins, and prompts.",
            })}
          </span>
        </div>
        {onClose && (
          <button
            className="icon-btn ghost"
            onClick={onClose}
            type="button"
            aria-label={t("settings.closeCodexSettings", {
              defaultValue: "Close Codex settings",
            })}
            title={t("settings.closeCodexSettings", {
              defaultValue: "Close Codex settings",
            })}
          >
            <X size={15} strokeWidth={1.8} />
          </button>
        )}
      </div>

      <div className="api-settings-actions codex-settings-actions">
        <button
          className="api-settings-action-btn primary"
          onClick={() => void handleImport()}
          type="button"
          disabled={isBusy}
        >
          {isImporting ? (
            <Loader2 size={15} className="spin" />
          ) : (
            <Download size={15} />
          )}
          <span>
            {t("settings.importCodex", {
              defaultValue: "Import Codex configuration",
            })}
          </span>
        </button>
        <button
          className="api-settings-action-btn secondary"
          onClick={() => void loadPreview()}
          type="button"
          disabled={isBusy}
          aria-label={t("settings.codexRefresh", {
            defaultValue: "Refresh Codex preview",
          })}
          title={t("settings.codexRefresh", {
            defaultValue: "Refresh Codex preview",
          })}
        >
          {isLoading ? (
            <Loader2 size={15} className="spin" />
          ) : (
            <RefreshCw size={15} />
          )}
          <span>
            {t("settings.codexRefresh", { defaultValue: "Refresh preview" })}
          </span>
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
          <div className="api-settings-summary-grid codex-settings-summary-grid">
            {summaryItems.map(({ icon: Icon, label, value, detail }) => (
              <div className="api-settings-summary-card" key={label}>
                <Icon size={15} strokeWidth={1.8} />
                <span>{label}</span>
                <strong className="codex-settings-summary-value">{value}</strong>
                {detail && <small>{detail}</small>}
              </div>
            ))}
          </div>

          <section className="api-settings-form-section codex-settings-source">
            <div className="api-settings-form-section-header">
              <strong className="api-settings-form-section-title">
                {t("settings.codexSource", { defaultValue: "Codex source" })}
              </strong>
              {preview.configFound ? (
                <span className="codex-settings-found">
                  <CheckCircle2 size={13} />
                  {t("settings.codexConfigFound", {
                    defaultValue: "config.toml found",
                  })}
                </span>
              ) : (
                <span className="codex-settings-missing">
                  {t("settings.codexConfigMissing", {
                    defaultValue: "config.toml not found",
                  })}
                </span>
              )}
            </div>
            <div className="codex-settings-path-list">
              <div className="codex-settings-path-row">
                <FolderOpen size={14} aria-hidden="true" />
                <span>{t("settings.codexHome", { defaultValue: "Codex Home" })}</span>
                <code title={preview.codexHome}>{preview.codexHome}</code>
              </div>
              <div className="codex-settings-path-row">
                <FileCode2 size={14} aria-hidden="true" />
                <span>{t("settings.codexConfigFile", { defaultValue: "Config file" })}</span>
                <code title={preview.configPath}>{preview.configPath}</code>
              </div>
              <div className="codex-settings-path-row">
                <MessageSquareText size={14} aria-hidden="true" />
                <span>
                  {t("settings.codexInstructions", { defaultValue: "Global instructions" })}
                </span>
                <code title={formatPath(preview.globalInstructionsPath)}>
                  {formatPath(preview.globalInstructionsPath)}
                </code>
              </div>
            </div>
          </section>

          {preview.warnings.length > 0 && (
            <section className="api-settings-form-section codex-settings-warnings">
              <strong className="api-settings-form-section-title">
                {t("settings.codexWarnings", { defaultValue: "Warnings" })}
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
            <section className="codex-settings-result" role="status">
              <CheckCircle2 size={15} aria-hidden="true" />
              <span>
                {t("settings.codexLastImport", {
                  defaultValue:
                    "Last import: {{mcp}} MCP, {{skills}} Skills, {{plugins}} Plugins, {{prompts}} prompts",
                  values: {
                    mcp:
                      lastResult.importedMcpServers +
                      lastResult.importedProjectMcpServers,
                    skills: lastResult.importedSkills,
                    plugins: lastResult.importedPlugins,
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
