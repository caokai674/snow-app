import type { ImportProvider, ImportScope } from "./importDiscovery";

export type PluginState = "enabled" | "disabled" | "update-available" | "broken";

export type PluginRuntimePermission = "storage" | "network" | "child-process";

export type PluginRuntimeDeclaration = {
  entry: string;
  permissions: PluginRuntimePermission[];
  timeoutMs: number;
};

export type PluginRuntimeState =
  | "unavailable"
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "timed-out"
  | "crashed"
  | "permission-denied"
  | "failed";

export type PluginRuntimeStatus = {
  state: PluginRuntimeState;
  message?: string;
  pid?: number;
  startedAt?: string;
};

export type PluginComponentType =
  | "skill"
  | "mcp"
  | "prompt"
  | "command"
  | "agent"
  | "hook";

export type PluginComponentStatus = "supported" | "unsupported";

export type PluginComponentInput = {
  componentId: string;
  componentType: PluginComponentType;
  logicalId: string;
  targetId: string;
  targetPath: string;
  originPath: string;
  contentHash: string;
  status: PluginComponentStatus;
  unsupportedReason?: string;
  sortOrder: number;
};

export type PluginInput = {
  pluginId: string;
  name: string;
  version: string;
  provider: ImportProvider;
  sourcePath: string;
  manifestPath: string;
  scope: ImportScope;
  projectId?: string;
  state: PluginState;
  capabilities: string[];
  runtime?: PluginRuntimeDeclaration;
  contentHash: string;
  components: PluginComponentInput[];
};

export type PluginComponentRecord = PluginComponentInput & {
  pluginId: string;
};

export type PluginRecord = Omit<PluginInput, "components"> & {
  importedAt: string;
  updatedAt: string;
  components: PluginComponentRecord[];
  runtimeStatus?: PluginRuntimeStatus;
};
