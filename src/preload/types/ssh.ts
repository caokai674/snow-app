export type SshAuthMethod = "password" | "privateKey" | "agent";

export type SshConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "degraded"
  | "reconnecting"
  | "offline"
  | "auth_required"
  | "host_key_changed";

/** A stable SSH profile handle; sessionId changes whenever the transport reconnects. */
export type SshProfileConnection = {
  profileId: string;
  sessionId?: string;
  generation: number;
  status: SshConnectionStatus;
  lastError?: string;
};

export type SshConnectParams = {
  host: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  hostKeyPolicy?: "replace";
};

export type SshDirectoryEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
};

export type SshCapabilities = {
  platform: "posix" | "windows";
  posixShell: boolean;
  systemdUser: boolean;
  tmux: boolean;
  setsid: boolean;
  nohup: boolean;
  powerShell: boolean;
  windowsJobObjects: boolean;
};

export type SshFileSaveGuarantee =
  | "strong_atomic"
  | "atomic_best_effort"
  | "compatibility";

export type SshFileVersion = {
  exists: boolean;
  sha256?: string;
  size?: number;
  mtime?: number;
};

export type SshFileWriteOptions = {
  /** Stable SSH workspace record that Main resolves to the authorized root. */
  workspaceId: string;
  /** Required write CAS precondition for all user-reachable saves. */
  expectedVersion: SshFileVersion;
};

export type SshFileWriteResult = {
  guarantee: SshFileSaveGuarantee;
  sideEffect: "committed";
  bytes: number;
  version: SshFileVersion;
  durability: {
    fsynced: boolean;
    posixRename: boolean;
  };
};

export type RemoteDraftStatus = "pending" | "conflict";

export type RemoteDraftInput = {
  profileId: string;
  workspaceId: string;
  remotePath: string;
  baseVersionJson: string;
  content: string;
  status: RemoteDraftStatus;
};

export type RemoteDraftRecord = RemoteDraftInput & {
  id: string;
  updatedAt: string;
};

export type RemoteWorkspaceFileSearchOptions = {
  query: string;
  listChildren: boolean;
};

export type SshCredentialRecord = {
  profileKey: string;
  host: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  privateKeyPath?: string;
  encryptedSecret?: string;
};

export type ParsedSshUrl = {
  host: string;
  port: number;
  username: string;
  remotePath: string;
};

export type RemoteJobStatus =
  | "preparing"
  | "launching"
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "lost"
  | "launch_failed"
  | "indeterminate";

export type RemoteJobBackendKind =
  | "snow-agent"
  | "systemd-user"
  | "tmux"
  | "posix-detach"
  | "windows-job";

export type RemoteJobCancellationPolicy = "cancel_remote" | "detach_only";

export type RemoteJobBinding = {
  jobId: string;
  workspacePath: string;
  workspaceId: string;
  profileId: string;
  commandHash: string;
  displayCommand: string;
  backend: RemoteJobBackendKind;
  cancellationPolicy?: RemoteJobCancellationPolicy;
  createdAt: string;
  updatedAt: string;
  status: RemoteJobStatus;
  revision: number;
  conversationId?: string;
  toolCallId?: string;
  lastOutputOffset: number;
  lastError?: string;
};

export type RemoteJobState = {
  schemaVersion: number;
  jobId: string;
  status: RemoteJobStatus;
  revision: number;
  backend?: RemoteJobBackendKind;
  runnerPid?: number;
  exitCode?: number;
  createdAt?: string;
  startedAt?: string;
  updatedAt: string;
  completedAt?: string;
  reason?: string;
};

export type RemoteJobStartRequest = {
  workspacePath: string;
  workspaceId?: string;
  command: string;
  timeoutMs?: number;
  jobId?: string;
  backend?: RemoteJobBackendKind;
  conversationId?: string;
  toolCallId?: string;
};

export type RemoteJobOutput = {
  job: RemoteJobBinding;
  state: RemoteJobState;
  output: string;
  /** Raw UTF-8 bytes. Decode incremental reads with TextDecoder stream mode. */
  outputBytes: Uint8Array;
  offset: number;
  nextOffset: number;
  eof: boolean;
};

export type RemoteJobPtyAttachment = {
  jobId: string;
  backend: RemoteJobBackendKind;
  ptyId: string;
};
