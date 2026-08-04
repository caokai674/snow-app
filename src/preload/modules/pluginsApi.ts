import { ipcRenderer } from "electron";
import type {
  PluginMarketplaceCatalog,
  PluginRecord,
  PluginRuntimePermission,
  PluginRuntimeStatus,
} from "../types/plugins";

export const pluginsApi = {
  listPlugins: (): Promise<PluginRecord[]> => ipcRenderer.invoke("plugins:list"),
  rescanPlugins: (): Promise<PluginRecord[]> => ipcRenderer.invoke("plugins:rescan"),
  setPluginEnabled: (pluginId: string, enabled: boolean): Promise<void> =>
    ipcRenderer.invoke("plugins:set-enabled", pluginId, enabled),
  startPluginRuntime: (pluginId: string, permissions: PluginRuntimePermission[]): Promise<PluginRuntimeStatus> =>
    ipcRenderer.invoke("plugins:start-runtime", pluginId, permissions),
  stopPluginRuntime: (pluginId: string): Promise<PluginRuntimeStatus> =>
    ipcRenderer.invoke("plugins:stop-runtime", pluginId),
  updatePlugin: (pluginId: string): Promise<void> => ipcRenderer.invoke("plugins:update", pluginId),
  removePlugin: (pluginId: string): Promise<void> => ipcRenderer.invoke("plugins:remove", pluginId),
  listPluginMarketplaces: (): Promise<PluginMarketplaceCatalog[]> => ipcRenderer.invoke("plugins:marketplaces:list"),
  addPluginMarketplace: (source: string): Promise<PluginMarketplaceCatalog[]> =>
    ipcRenderer.invoke("plugins:marketplaces:add", source),
  updatePluginMarketplace: (marketplaceId: string): Promise<PluginMarketplaceCatalog[]> =>
    ipcRenderer.invoke("plugins:marketplaces:update", marketplaceId),
  removePluginMarketplace: (marketplaceId: string): Promise<void> =>
    ipcRenderer.invoke("plugins:marketplaces:remove", marketplaceId),
  installPluginFromMarketplace: (marketplaceId: string, pluginName: string): Promise<void> =>
    ipcRenderer.invoke("plugins:marketplaces:install", marketplaceId, pluginName),
};
