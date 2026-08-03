import {
  CircleCheck,
  CirclePause,
  FileWarning,
  Loader2,
  Play,
  RefreshCw,
  Square,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  Unplug,
  Wrench,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { PluginComponentRecord, PluginRecord, PluginRuntimePermission } from "../../../preload";
import { useI18n } from "../../i18n";
import { AutoDismissNotice } from "../AutoDismissNotice";
import { ConfirmDialog } from "../common/ConfirmDialog";

type PluginsSettingsPanelProps = {
  onClose?: () => void;
};

const componentLabel = (component: PluginComponentRecord): string =>
  component.componentType === "mcp"
    ? "MCP"
    : component.componentType === "skill"
      ? "Skill"
      : component.componentType === "prompt"
        ? "Prompt"
        : component.componentType === "command"
          ? "Command"
          : component.componentType === "agent"
            ? "Agent"
            : "Hook";

const runtimePermissionLabel = (permission: PluginRuntimePermission): string =>
  permission === "storage"
    ? "Plugin storage"
    : permission === "network"
      ? "Network"
      : "Child process";

export function PluginsSettingsPanel({ onClose }: PluginsSettingsPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const [plugins, setPlugins] = useState<PluginRecord[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [busyPluginId, setBusyPluginId] = useState("");
  const [expandedPluginId, setExpandedPluginId] = useState("");
  const [pendingRemoval, setPendingRemoval] = useState<PluginRecord | null>(null);
  const [pendingRuntimeStart, setPendingRuntimeStart] = useState<PluginRecord | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  const load = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setError("");
    try {
      setPlugins(await window.snow.listPlugins());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t("settings.pluginsLoadError", {
        defaultValue: "Failed to load Plugins",
      }));
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const hasActiveRuntime = plugins.some((plugin) => {
      const state = plugin.runtimeStatus?.state;
      return state === "starting" || state === "running" || state === "stopping";
    });
    if (!hasActiveRuntime) return;
    const timer = window.setInterval(() => {
      void window.snow.listPlugins().then(setPlugins).catch(() => undefined);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [plugins]);

  const rescan = async (): Promise<void> => {
    setIsLoading(true);
    setError("");
    setStatus("");
    try {
      setPlugins(await window.snow.rescanPlugins());
      setStatus(t("settings.pluginsRescanSuccess", { defaultValue: "Plugin sources rescanned." }));
    } catch (rescanError) {
      setError(rescanError instanceof Error ? rescanError.message : t("settings.pluginsRescanError", {
        defaultValue: "Failed to rescan Plugins",
      }));
    } finally {
      setIsLoading(false);
    }
  };

  const toggleEnabled = async (plugin: PluginRecord): Promise<void> => {
    const enable = plugin.state !== "enabled";
    setBusyPluginId(plugin.pluginId);
    setError("");
    setStatus("");
    try {
      await window.snow.setPluginEnabled(plugin.pluginId, enable);
      await load();
      setStatus(t(enable ? "settings.pluginsEnableSuccess" : "settings.pluginsDisableSuccess", {
        defaultValue: enable ? "Plugin enabled." : "Plugin disabled.",
      }));
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : t("settings.pluginsUpdateError", {
        defaultValue: "Failed to update Plugin",
      }));
    } finally {
      setBusyPluginId("");
    }
  };

  const update = async (plugin: PluginRecord): Promise<void> => {
    setBusyPluginId(plugin.pluginId);
    setError("");
    setStatus("");
    try {
      await window.snow.updatePlugin(plugin.pluginId);
      await load();
      setStatus(t("settings.pluginsUpdateSuccess", { defaultValue: "Plugin updated." }));
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : t("settings.pluginsUpdateError", {
        defaultValue: "Failed to update Plugin",
      }));
    } finally {
      setBusyPluginId("");
    }
  };

  const startRuntime = async (): Promise<void> => {
    const plugin = pendingRuntimeStart;
    if (!plugin?.runtime) return;
    setPendingRuntimeStart(null);
    setBusyPluginId(plugin.pluginId);
    setError("");
    setStatus("");
    try {
      const result = await window.snow.startPluginRuntime(plugin.pluginId, plugin.runtime.permissions);
      await load();
      setStatus(result.message || t("settings.pluginsRuntimeStartSuccess", { defaultValue: "Plugin runtime started." }));
    } catch (runtimeError) {
      setError(runtimeError instanceof Error ? runtimeError.message : t("settings.pluginsRuntimeStartError", {
        defaultValue: "Failed to start Plugin runtime",
      }));
    } finally {
      setBusyPluginId("");
    }
  };

  const stopRuntime = async (plugin: PluginRecord): Promise<void> => {
    setBusyPluginId(plugin.pluginId);
    setError("");
    setStatus("");
    try {
      const result = await window.snow.stopPluginRuntime(plugin.pluginId);
      await load();
      setStatus(result.message || t("settings.pluginsRuntimeStopSuccess", { defaultValue: "Plugin runtime stopped." }));
    } catch (runtimeError) {
      setError(runtimeError instanceof Error ? runtimeError.message : t("settings.pluginsRuntimeStopError", {
        defaultValue: "Failed to stop Plugin runtime",
      }));
    } finally {
      setBusyPluginId("");
    }
  };

  const remove = async (): Promise<void> => {
    const plugin = pendingRemoval;
    if (!plugin) return;
    setPendingRemoval(null);
    setBusyPluginId(plugin.pluginId);
    setError("");
    setStatus("");
    try {
      await window.snow.removePlugin(plugin.pluginId);
      await load();
      setStatus(t("settings.pluginsRemoveSuccess", { defaultValue: "Plugin removed." }));
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : t("settings.pluginsRemoveError", {
        defaultValue: "Failed to remove Plugin",
      }));
    } finally {
      setBusyPluginId("");
    }
  };

  const enabledCount = plugins.filter((plugin) => plugin.state === "enabled").length;
  const brokenCount = plugins.filter((plugin) => plugin.state === "broken").length;

  return (
    <div className="api-settings-page plugins-settings-page" role="region">
      <div className="api-settings-page-header">
        <div className="api-settings-title-group">
          <strong>{t("settings.pluginsSettings", { defaultValue: "Plugins" })}</strong>
          <span className="settings-item-description">
            {t("settings.pluginsSettingsInfo", { defaultValue: "Manage imported declarative Plugin components." })}
          </span>
        </div>
        <div className="api-settings-header-actions">
          <button
            className="icon-btn ghost"
            type="button"
            onClick={() => void rescan()}
            disabled={isLoading || Boolean(busyPluginId)}
            aria-label={t("settings.pluginsRescan", { defaultValue: "Rescan Plugins" })}
            title={t("settings.pluginsRescan", { defaultValue: "Rescan Plugins" })}
          >
            {isLoading ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
          </button>
          {onClose ? (
            <button
              className="icon-btn ghost"
              type="button"
              onClick={onClose}
              aria-label={t("settings.closePluginsSettings", { defaultValue: "Close Plugins settings" })}
              title={t("settings.closePluginsSettings", { defaultValue: "Close Plugins settings" })}
            >
              <X size={15} />
            </button>
          ) : null}
        </div>
      </div>

      <div className="api-settings-summary-grid plugins-settings-summary-grid">
        <div className="api-settings-summary-card"><Wrench size={15} /><span>{t("settings.pluginsInstalled", { defaultValue: "Installed" })}</span><strong>{plugins.length}</strong></div>
        <div className="api-settings-summary-card"><CircleCheck size={15} /><span>{t("settings.pluginsEnabled", { defaultValue: "Enabled" })}</span><strong>{enabledCount}</strong></div>
        <div className="api-settings-summary-card"><TriangleAlert size={15} /><span>{t("settings.pluginsIssues", { defaultValue: "Issues" })}</span><strong>{brokenCount}</strong></div>
      </div>

      <AutoDismissNotice message={status} tone="success" onDismiss={() => setStatus("")} />
      <AutoDismissNotice message={error} tone="error" onDismiss={() => setError("")} />

      <section className="api-settings-form-section plugins-settings-list" aria-label={t("settings.pluginsList", { defaultValue: "Plugin list" })}>
        {plugins.length === 0 && !isLoading ? (
          <div className="settings-empty-state">{t("settings.pluginsEmpty", { defaultValue: "No imported Plugins." })}</div>
        ) : plugins.map((plugin) => {
          const busy = busyPluginId === plugin.pluginId;
          const expanded = expandedPluginId === plugin.pluginId;
          const unsupported = plugin.components.filter((item) => item.status === "unsupported").length;
          const runtimeState = plugin.runtimeStatus?.state ?? "unavailable";
          const runtimeActive = runtimeState === "starting" || runtimeState === "running" || runtimeState === "stopping";
          return (
            <article className="plugin-settings-item" key={plugin.pluginId}>
              <div className="plugin-settings-item-main">
                <button
                  type="button"
                  className="plugin-settings-name"
                  onClick={() => setExpandedPluginId(expanded ? "" : plugin.pluginId)}
                  aria-expanded={expanded}
                >
                  <strong>{plugin.name}</strong>
                  <span>{plugin.provider}{plugin.version ? ` ${plugin.version}` : ""}</span>
                </button>
                <span className={`plugin-settings-state state-${plugin.state}`}>{plugin.state}</span>
                <span className="plugin-settings-count">{plugin.components.length}</span>
                <div className="plugin-settings-actions">
                  <button
                    className={`icon-btn ghost ${plugin.state === "enabled" ? "primary" : ""}`}
                    type="button"
                    disabled={busy || isLoading || plugin.state === "broken"}
                    onClick={() => void toggleEnabled(plugin)}
                    aria-label={t(plugin.state === "enabled" ? "settings.pluginsDisable" : "settings.pluginsEnable", { defaultValue: plugin.state === "enabled" ? "Disable Plugin" : "Enable Plugin" })}
                    title={t(plugin.state === "enabled" ? "settings.pluginsDisable" : "settings.pluginsEnable", { defaultValue: plugin.state === "enabled" ? "Disable Plugin" : "Enable Plugin" })}
                  >
                    {busy ? <Loader2 size={15} className="spin" /> : plugin.state === "enabled" ? <CirclePause size={15} /> : <CircleCheck size={15} />}
                  </button>
                  {plugin.runtime ? (
                    <button
                      className={`icon-btn ghost ${runtimeActive ? "primary" : ""}`}
                      type="button"
                      disabled={busy || isLoading || plugin.state !== "enabled"}
                      onClick={() => runtimeActive ? void stopRuntime(plugin) : setPendingRuntimeStart(plugin)}
                      aria-label={t(runtimeActive ? "settings.pluginsRuntimeStop" : "settings.pluginsRuntimeStart", { defaultValue: runtimeActive ? "Stop Plugin runtime" : "Start Plugin runtime" })}
                      title={t(runtimeActive ? "settings.pluginsRuntimeStop" : "settings.pluginsRuntimeStart", { defaultValue: runtimeActive ? "Stop Plugin runtime" : "Start Plugin runtime" })}
                    >
                      {busy ? <Loader2 size={15} className="spin" /> : runtimeActive ? <Square size={14} /> : <Play size={15} />}
                    </button>
                  ) : null}
                  {plugin.state === "update-available" ? (
                    <button
                      className="icon-btn ghost"
                      type="button"
                      disabled={busy || isLoading}
                      onClick={() => void update(plugin)}
                      aria-label={t("settings.pluginsUpdate", { defaultValue: "Update Plugin" })}
                      title={t("settings.pluginsUpdate", { defaultValue: "Update Plugin" })}
                    ><RefreshCw size={15} /></button>
                  ) : null}
                  <button
                    className="icon-btn ghost danger"
                    type="button"
                    disabled={busy || isLoading}
                    onClick={() => setPendingRemoval(plugin)}
                    aria-label={t("settings.pluginsRemove", { defaultValue: "Remove Plugin" })}
                    title={t("settings.pluginsRemove", { defaultValue: "Remove Plugin" })}
                  ><Trash2 size={15} /></button>
                </div>
              </div>
              {expanded ? (
                <div className="plugin-settings-components">
                  <div className="plugin-settings-path" title={plugin.sourcePath}>{plugin.sourcePath}</div>
                  {plugin.runtime ? (
                    <div className={`plugin-settings-runtime state-${runtimeState}`}>
                      <ShieldCheck size={14} />
                      <span>{t("settings.pluginsRuntime", { defaultValue: "Runtime" })}</span>
                      <code>{plugin.runtime.entry}</code>
                      <small>{t(`settings.pluginsRuntimeState.${runtimeState}`, { defaultValue: runtimeState })}</small>
                      <small>{plugin.runtime.permissions.length > 0
                        ? plugin.runtime.permissions.map(runtimePermissionLabel).join(", ")
                        : t("settings.pluginsRuntimeNoPermissions", { defaultValue: "No additional permissions" })}</small>
                      {plugin.runtimeStatus?.message ? <small>{plugin.runtimeStatus.message}</small> : null}
                    </div>
                  ) : null}
                  {plugin.components.map((component) => (
                    <div className={`plugin-settings-component ${component.status}`} key={component.componentId}>
                      {component.status === "unsupported" ? <FileWarning size={14} /> : <Unplug size={14} />}
                      <span>{componentLabel(component)}</span>
                      <code>{component.logicalId}</code>
                      {component.unsupportedReason ? <small>{component.unsupportedReason}</small> : null}
                    </div>
                  ))}
                  {unsupported > 0 ? <span className="plugin-settings-unsupported-count">{unsupported}</span> : null}
                </div>
              ) : null}
            </article>
          );
        })}
      </section>

      <ConfirmDialog
        open={Boolean(pendingRuntimeStart)}
        title={t("settings.pluginsRuntimeStart", { defaultValue: "Start Plugin runtime" })}
        message={pendingRuntimeStart?.runtime
          ? `${t("settings.pluginsRuntimeConfirm", { defaultValue: "Run external Plugin code in an isolated utility process. Only run code you trust." })} ${pendingRuntimeStart.runtime.permissions.length > 0
            ? `${t("settings.pluginsRuntimePermissions", { defaultValue: "Requested permissions:" })} ${pendingRuntimeStart.runtime.permissions.map(runtimePermissionLabel).join(", ")}.`
            : t("settings.pluginsRuntimeNoPermissions", { defaultValue: "No additional permissions" })}`
          : ""}
        confirmLabel={t("settings.pluginsRuntimeStart", { defaultValue: "Start Plugin runtime" })}
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        onConfirm={() => void startRuntime()}
        onCancel={() => setPendingRuntimeStart(null)}
        variant="warning"
      />

      <ConfirmDialog
        open={Boolean(pendingRemoval)}
        title={t("settings.pluginsRemove", { defaultValue: "Remove Plugin" })}
        message={t("settings.pluginsRemoveConfirm", { defaultValue: "Remove this Plugin and its Snow-managed components?" })}
        confirmLabel={t("settings.pluginsRemove", { defaultValue: "Remove Plugin" })}
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        onConfirm={() => void remove()}
        onCancel={() => setPendingRemoval(null)}
        variant="danger"
      />
    </div>
  );
}
